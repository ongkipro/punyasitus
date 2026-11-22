import { z } from "zod";
import { sanitizeExternalLink } from "../link-sanitizer.ts";
import {
  renderRichTextDocToSanitizedHtml,
  sanitizeRichTextDoc,
  sanitizeRichTextHtml,
} from "./rich-text.ts";

export * from "./rich-text.ts";
import {
  ContentLifecycleStatusSchema,
  MenuLocationSchema,
  ResourceSeoInputSchema,
  RestrictedRichTextDocSchema,
} from "../schemas/cms.ts";
import {
  EmailSchema,
  FORBIDDEN_TENANT_SELECTOR_KEYS,
  HttpsUrlSchema,
  IdrAmountSchema,
  NormalizedPhoneSchema,
  OfferingCtaKindSchema,
  OfferingTypeSchema,
  PriceModeSchema,
  SequentialIdSchema,
  SlugSchema,
  ThemeIdSchema,
  VehicleUnitStatusSchema,
  VersionSchema,
} from "../schemas/common.ts";
import {
  PublicBusinessHoursSchema,
  PublicMenuItemLevel1Schema,
  PublicOfferingAttributesSchema,
  PublicPageSectionDtoSchema,
  PublicSocialLinkSchema,
} from "../schemas/public-dto.ts";
import {
  ThemeValidationError,
  validateThemeConfigSnapshot,
  type ThemeConfigSnapshot,
} from "../theme/index.ts";

/**
 * Shared Draft / Published Snapshot Validators, Sanitizers, DTO Builders &
 * Concurrency Error Types for Publishable Tenant Resources (REQ-036, REQ-001, TASK-027).
 *
 * Reusable across Wave 3 CMS tasks (`TASK-005`, `006`, `008`, `009`, `012`, `013`, `050`, `051`).
 */

export const PUBLISHABLE_RESOURCE_TYPES = [
  "page",
  "post",
  "offering",
  "site_settings",
  "business_profile",
  "theme_config",
  "menu",
] as const;
export type PublishableResourceType = (typeof PUBLISHABLE_RESOURCE_TYPES)[number];

export const LIFECYCLE_RESOURCE_TYPES = ["page", "post", "offering"] as const;
export type LifecycleResourceType = (typeof LIFECYCLE_RESOURCE_TYPES)[number];

export const CONFIG_RESOURCE_TYPES = [
  "site_settings",
  "business_profile",
  "theme_config",
  "menu",
] as const;
export type ConfigResourceType = (typeof CONFIG_RESOURCE_TYPES)[number];

export type ResourceLifecycleStatus = z.infer<typeof ContentLifecycleStatusSchema>;

/**
 * Draft-only / editorial / internal field names that MUST NEVER appear inside
 * any published public snapshot DTO.
 */
export const DRAFT_ONLY_FIELD_NAMES = new Set<string>([
  "draftNotes",
  "internalNotes",
  "editorialNotes",
  "reviewComments",
  "draftByUserId",
  "lastEditedBy",
  "previewToken",
  "unpublishedChanges",
  "draftJson",
  "draftSectionsJson",
  "draftBodyJson",
  "draftSnapshotJson",
  "draftItemsJson",
  "draft_json",
  "draft_sections_json",
  "draft_body_json",
  "draft_snapshot_json",
  "draft_items_json",
]);

const FORBIDDEN_SELECTOR_SET = new Set<string>(FORBIDDEN_TENANT_SELECTOR_KEYS);

export interface PublicationValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * HTTP 409 CONFLICT error raised when an optimistic concurrency lock
 * (`WHERE id = ? AND version = ?`) fails because the resource moved ahead.
 */
export class StaleRevisionError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "STALE_VERSION" as const;
  readonly resourceType: PublishableResourceType;
  readonly resourceId: number | string;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(params: {
    readonly resourceType: PublishableResourceType;
    readonly resourceId: number | string;
    readonly expectedVersion: number;
    readonly actualVersion?: number | null;
    readonly message?: string;
  }) {
    super(
      params.message ??
        `Stale revision for ${params.resourceType}#${String(params.resourceId)}: expected version ${params.expectedVersion}${
          params.actualVersion !== undefined && params.actualVersion !== null
            ? `, current version is ${params.actualVersion}`
            : ""
        }`,
    );
    this.name = "StaleRevisionError";
    this.resourceType = params.resourceType;
    this.resourceId = params.resourceId;
    this.expectedVersion = params.expectedVersion;
    this.actualVersion = params.actualVersion ?? null;
  }
}

/**
 * HTTP 422 UNPROCESSABLE ENTITY error raised when draft or publish snapshot
 * validation fails (schema violation, CSS injection, pricing invariant, unsafe URL, etc.).
 */
export class PublicationValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly PublicationValidationField[];

  constructor(message: string, fields: readonly PublicationValidationField[] = []) {
    super(message);
    this.name = "PublicationValidationError";
    this.fields = fields;
  }
}

/**
 * HTTP 404 NOT FOUND error raised when the target tenant resource does not exist
 * or has been soft-deleted.
 */
export class PublicationNotFoundError extends Error {
  readonly httpStatus = 404 as const;
  readonly code = "NOT_FOUND" as const;
  readonly resourceType: PublishableResourceType;
  readonly resourceId: number | string;

  constructor(resourceType: PublishableResourceType, resourceId: number | string) {
    super(`Resource ${resourceType}#${String(resourceId)} not found`);
    this.name = "PublicationNotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

/**
 * HTTP 503 SERVICE UNAVAILABLE error raised when cross-tier atomic publication
 * fails during `PLATFORM_DB.tenants.cache_version` bump and triggers rollback.
 */
export class PublicationAtomicError extends Error {
  readonly httpStatus = 503 as const;
  readonly code = "SERVICE_UNAVAILABLE" as const;
  readonly compensated: boolean;

  constructor(message: string, options: { readonly compensated: boolean; readonly cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "PublicationAtomicError";
    this.compensated = options.compensated;
  }
}

// ---------------------------------------------------------------------------
// Sanitizers (HTML fragments & navigation hrefs)
// ---------------------------------------------------------------------------

function hasAsciiControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Validates and sanitizes navigation / CTA hrefs for pages and menus.
 * Allows root-relative paths (`/foo`), fragment anchors (`#section`),
 * `mailto:`, `tel:`, or validated `https://` URLs. Rejects `javascript:`,
 * `data:`, `vbscript:`, protocol-relative `//`, and control characters.
 */
export function sanitizeNavigationHref(rawHref: string, field = "href"): string {
  if (typeof rawHref !== "string" || hasAsciiControlChars(rawHref)) {
    throw new PublicationValidationError(`Unsafe URL in ${field}`, [
      { field, code: "UNSAFE_URL", message: "URL must not contain control characters" },
    ]);
  }
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.length > 2048) {
    throw new PublicationValidationError(`Invalid URL length in ${field}`, [
      { field, code: "INVALID_URL", message: "URL must be 1..2048 characters" },
    ]);
  }
  if (trimmed.startsWith("//")) {
    throw new PublicationValidationError(`Protocol-relative URL forbidden in ${field}`, [
      { field, code: "UNSAFE_URL", message: "Protocol-relative URLs are not allowed" },
    ]);
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) {
    if (/[<>"]/.test(trimmed)) {
      throw new PublicationValidationError(`Unsafe characters in relative URL ${field}`, [
        { field, code: "UNSAFE_URL", message: "Relative URL contains unsafe characters" },
      ]);
    }
    return trimmed;
  }
  if (/^mailto:[^\s<>"]+$/i.test(trimmed) || /^tel:\+?[0-9\s()-]{5,25}$/i.test(trimmed)) {
    return trimmed;
  }
  try {
    return sanitizeExternalLink(trimmed).href;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid external URL";
    throw new PublicationValidationError(`Unsafe external URL in ${field}`, [
      { field, code: "UNSAFE_URL", message: msg },
    ]);
  }
}

/**
 * Strips dangerous HTML tags (`script`, `iframe`, `object`, `embed`, `form`, `style`),
 * inline `on*=` event attributes, and `javascript:`/`vbscript:`/`data:` URI payloads
 * from rendered HTML fragments before snapshot publication.
 */
export function sanitizePublishedHtmlFragment(raw: string): string {
  let clean = raw;
  // Remove entire dangerous tag blocks
  clean = clean.replace(
    /<\s*(script|iframe|object|embed|form|style|meta|link|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  // Remove self-closing / unclosed dangerous tags
  clean = clean.replace(/<\s*\/?\s*(script|iframe|object|embed|form|style|meta|link|base)\b[^>]*>/gi, "");
  // Remove inline event handlers (onclick=, onerror=, onload=, etc.)
  clean = clean.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Remove inline style attributes (PLAN §7.3: no arbitrary inline styles)
  clean = clean.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralize javascript:/vbscript:/data: URIs inside href/src attributes
  clean = clean.replace(
    /\b(href|src)\s*=\s*(?:"\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*')/gi,
    '$1=""',
  );
  return clean;
}

/**
 * Detects any forbidden cross-tenant selector key (`tenantId`, `organizationId`, etc.)
 * anywhere in an untrusted object graph (PLAN §2, §4, §6).
 */
export function assertNoForbiddenTenantSelectors(value: unknown, pathPrefix = ""): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoForbiddenTenantSelectors(value[i], `${pathPrefix}[${i}]`);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_SELECTOR_SET.has(key)) {
      throw new PublicationValidationError(
        `Forbidden tenant selector field "${key}" in input payload`,
        [
          {
            field: nextPath,
            code: "FORBIDDEN_TENANT_SELECTOR",
            message: `Field "${key}" is forbidden in tenant-scoped payloads`,
          },
        ],
      );
    }
    assertNoForbiddenTenantSelectors(nested, nextPath);
  }
}

/**
 * Recursively strips draft-only / editorial metadata fields from a snapshot object
 * so they can NEVER leak into published public DTOs.
 */
export function stripDraftOnlyFields<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripDraftOnlyFields(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (DRAFT_ONLY_FIELD_NAMES.has(key)) {
      continue;
    }
    out[key] = stripDraftOnlyFields(nested);
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Snapshot Schemas for All 7 Publishable Tenant Resources
// ---------------------------------------------------------------------------

export const PageLayoutModeSchema = z.enum(["standard", "focused"]);
export type PageLayoutMode = z.infer<typeof PageLayoutModeSchema>;

export const MAX_SEO_TITLE_LENGTH = 70 as const;
export const MAX_SEO_DESCRIPTION_LENGTH = 160 as const;

const SAFE_CANONICAL_PATH_REGEX = /^\/(?:[A-Za-z0-9._~:@!$&'()*+,;=-]+(?:\/[A-Za-z0-9._~:@!$&'()*+,;=-]+)*)?$/;

/**
 * Validates a safe canonical override URL:
 * - Allows validated public `https://` URLs (no embedded credentials, no localhost/private IPs, no control chars)
 * - Or clean root-relative paths (`/tentang-kami`) without `//`, `..`, `<`, `>`, or control chars
 * - Rejects `http://`, `javascript:`, `data:`, `vbscript:`, protocol-relative `//`, and HTML injection.
 */
export function validateCanonicalOverride(raw: string, field = "seo.canonicalOverride"): string {
  if (typeof raw !== "string" || hasAsciiControlChars(raw)) {
    throw new PublicationValidationError("Invalid canonicalOverride URL", [
      {
        field,
        code: "INVALID_CANONICAL_URL",
        message: "canonicalOverride must not contain control characters",
      },
    ]);
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) {
    throw new PublicationValidationError("Invalid canonicalOverride URL length", [
      {
        field,
        code: "INVALID_CANONICAL_URL",
        message: "canonicalOverride must be 1..2048 characters",
      },
    ]);
  }
  if (trimmed.startsWith("//")) {
    throw new PublicationValidationError("Protocol-relative canonicalOverride is forbidden", [
      {
        field,
        code: "INVALID_CANONICAL_URL",
        message: "Protocol-relative URLs are not allowed in canonicalOverride",
      },
    ]);
  }
  if (trimmed.startsWith("/")) {
    if (trimmed.includes("..") || !SAFE_CANONICAL_PATH_REGEX.test(trimmed)) {
      throw new PublicationValidationError("Unsafe root-relative path in canonicalOverride", [
        {
          field,
          code: "INVALID_CANONICAL_URL",
          message: "canonicalOverride path contains invalid or unsafe segments",
        },
      ]);
    }
    return trimmed;
  }
  const parsedHttps = HttpsUrlSchema.safeParse(trimmed);
  if (!parsedHttps.success) {
    throw new PublicationValidationError("Unsafe canonicalOverride URL", [
      {
        field,
        code: "INVALID_CANONICAL_URL",
        message: "canonicalOverride must be a valid public https:// URL or root-relative path",
      },
    ]);
  }
  return parsedHttps.data;
}

const PageSeoTextField = (maxLen: number, label: string) =>
  z
    .string()
    .trim()
    .max(maxLen, `${label} must be at most ${maxLen} characters`)
    .refine((v) => !hasAsciiControlChars(v), `${label} must not contain control characters`)
    .refine((v) => !/<\s*\/?\s*(?:script|iframe|style|object|embed)\b/i.test(v), `${label} must not contain executable HTML tags`);

/**
 * Full per-page SEO override schema supporting both canonical OpenAPI fields
 * (`titleOverride`, `descriptionOverride`, `ogImageMediaId`, `noindex`, `nofollow`, `schemaType`, ...)
 * and `TASK-005` aliases (`seoTitle` <= 70, `seoDescription` <= 160, `canonicalOverride`).
 */
export const PageSeoOverridesSchema = z
  .object({
    seoTitle: PageSeoTextField(MAX_SEO_TITLE_LENGTH, "seoTitle").nullable().optional(),
    seoDescription: PageSeoTextField(MAX_SEO_DESCRIPTION_LENGTH, "seoDescription").nullable().optional(),
    titleOverride: PageSeoTextField(MAX_SEO_TITLE_LENGTH, "titleOverride").nullable().optional(),
    descriptionOverride: PageSeoTextField(MAX_SEO_DESCRIPTION_LENGTH, "descriptionOverride")
      .nullable()
      .optional(),
    focusKeyphrase: PageSeoTextField(100, "focusKeyphrase").nullable().optional(),
    ogTitleOverride: PageSeoTextField(200, "ogTitleOverride").nullable().optional(),
    ogDescriptionOverride: PageSeoTextField(500, "ogDescriptionOverride").nullable().optional(),
    ogImageMediaId: SequentialIdSchema.nullable().optional(),
    schemaType: ResourceSeoInputSchema.shape.schemaType,
    noindex: z.boolean().optional(),
    nofollow: z.boolean().optional(),
    canonicalOverride: z.string().trim().max(2048).nullable().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.seoTitle !== undefined &&
      val.seoTitle !== null &&
      val.titleOverride !== undefined &&
      val.titleOverride !== null &&
      val.seoTitle !== val.titleOverride
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["seoTitle"],
        message: "seoTitle and titleOverride must match when both are supplied",
      });
    }
    if (
      val.seoDescription !== undefined &&
      val.seoDescription !== null &&
      val.descriptionOverride !== undefined &&
      val.descriptionOverride !== null &&
      val.seoDescription !== val.descriptionOverride
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["seoDescription"],
        message: "seoDescription and descriptionOverride must match when both are supplied",
      });
    }
    if (val.canonicalOverride !== undefined && val.canonicalOverride !== null) {
      try {
        validateCanonicalOverride(val.canonicalOverride, "canonicalOverride");
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          path: ["canonicalOverride"],
          message: err instanceof Error ? err.message : "Invalid canonicalOverride URL",
        });
      }
    }
  });

export type PageSeoOverrides = z.infer<typeof PageSeoOverridesSchema>;

/**
 * Validates per-page SEO overrides and normalizes `canonicalOverride` when present.
 * Throws `PublicationValidationError` (422) on invalid lengths, unsafe URLs, or unknown fields.
 */
export function validatePageSeoOverrides(input: unknown): PageSeoOverrides | null {
  if (input === null || input === undefined) {
    return null;
  }
  assertNoForbiddenTenantSelectors(input, "seo");
  const parsed = PageSeoOverridesSchema.safeParse(input);
  if (!parsed.success) {
    const fields: PublicationValidationField[] = parsed.error.issues.map((issue) => ({
      field: issue.path.length > 0 ? `seo.${issue.path.join(".")}` : "seo",
      code: issue.code.toUpperCase(),
      message: issue.message,
    }));
    throw new PublicationValidationError("Invalid page SEO overrides", fields);
  }
  const data = parsed.data;
  return {
    ...data,
    ...(data.canonicalOverride !== undefined && data.canonicalOverride !== null
      ? { canonicalOverride: validateCanonicalOverride(data.canonicalOverride) }
      : {}),
  };
}

/**
 * Validates Landing Page Focus Mode (`standard` vs `focused`; REQ-008, DEC-038).
 */
export function validatePageLayoutMode(input: unknown, field = "layoutMode"): PageLayoutMode {
  const parsed = PageLayoutModeSchema.safeParse(input);
  if (!parsed.success) {
    throw new PublicationValidationError(
      `Invalid ${field}: expected "standard" or "focused"`,
      [
        {
          field,
          code: "INVALID_LAYOUT_MODE",
          message: 'layoutMode must be either "standard" or "focused"',
        },
      ],
    );
  }
  return parsed.data;
}

export const PageSnapshotSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().trim().min(1).max(200),
    isHomepage: z.boolean().default(false),
    layoutMode: PageLayoutModeSchema.default("standard"),
    sections: z.array(PublicPageSectionDtoSchema).max(30).default([]),
    seo: PageSeoOverridesSchema.nullable().optional(),
  })
  .strict();

export const PostSnapshotSchema = z
  .object({
    slug: SlugSchema,
    title: z.string().trim().min(1).max(200),
    excerpt: z.string().max(500).nullable().optional(),
    body: RestrictedRichTextDocSchema,
    sanitizedHtml: z.string().max(250_000).optional(),
    primaryCategoryId: SequentialIdSchema.nullable().optional(),
    categoryIds: z.array(SequentialIdSchema).max(10).optional(),
    tagIds: z.array(SequentialIdSchema).max(20).optional(),
    authorId: SequentialIdSchema.nullable().optional(),
    authorUserId: z.string().trim().min(1).max(64).nullable().optional(),
    authorName: z.string().trim().min(1).max(120).nullable().optional(),
    coverMediaId: SequentialIdSchema.nullable().optional(),
    readingTimeMinutes: z.number().int().min(1).max(180).default(1),
    showToc: z.boolean().default(false),
    seo: PageSeoOverridesSchema.nullable().optional(),
  })
  .strict();

export const OfferingSnapshotSchema = z
  .object({
    offeringType: OfferingTypeSchema,
    slug: SlugSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().max(500).nullable().optional(),
    description: z.union([RestrictedRichTextDocSchema, z.string().max(100_000)]).nullable().optional(),
    coverMediaId: SequentialIdSchema.nullable().optional(),
    galleryMediaIds: z.array(SequentialIdSchema).max(12).default([]),
    videoMediaId: SequentialIdSchema.nullable().optional(),
    youtubeVideoId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/)
      .nullable()
      .optional(),
    priceMode: PriceModeSchema.default("on_request"),
    price: IdrAmountSchema.nullable().optional(),
    priceMax: IdrAmountSchema.nullable().optional(),
    negotiable: z.boolean().default(false),
    originalAmount: IdrAmountSchema.nullable().optional(),
    badge: z.string().max(40).nullable().optional(),
    ctaMode: OfferingCtaKindSchema.default("whatsapp"),
    externalUrl: HttpsUrlSchema.nullable().optional(),
    unitStatus: VehicleUnitStatusSchema.nullable().optional(),
    attributesVersion: VersionSchema.default(1),
    attributes: PublicOfferingAttributesSchema.default({}),
    seo: ResourceSeoInputSchema.nullable().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.priceMode === "on_request") {
      if (val.price !== undefined && val.price !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["price"],
          message: "on_request offerings must not supply a fabricated price",
        });
      }
    } else if (val.price === undefined || val.price === null) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "price is required for fixed, from, and range pricing modes",
      });
    }
    if (
      val.priceMode === "range" &&
      val.price !== undefined &&
      val.price !== null &&
      (val.priceMax === undefined || val.priceMax === null || val.priceMax < val.price)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["priceMax"],
        message: "priceMax must be >= price for range pricing",
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
        message: "originalAmount must strictly exceed price when present",
      });
    }
    if (val.ctaMode === "external_link" && !val.externalUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["externalUrl"],
        message: "externalUrl is required when ctaMode is external_link",
      });
    }
  });

export const AnalyticsPublicConfigSchema = z
  .object({
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
    metaPixelId: z
      .string()
      .regex(/^[0-9]{8,20}$/)
      .nullable()
      .optional(),
    tiktokPixelId: z
      .string()
      .regex(/^[A-Z0-9]{8,32}$/)
      .nullable()
      .optional(),
  })
  .strict();

export const SiteSettingsSnapshotSchema = z
  .object({
    siteTitle: z.string().trim().min(1).max(120),
    tagline: z.string().max(240).nullable().optional(),
    timezone: z.string().min(1).max(64).default("Asia/Jakarta"),
    locale: z.string().min(2).max(16).default("id-ID"),
    activeThemeId: ThemeIdSchema.default("compro"),
    faviconMediaId: SequentialIdSchema.nullable().optional(),
    ogImageMediaId: SequentialIdSchema.nullable().optional(),
    blogEnabled: z.boolean().default(true),
    catalogEnabled: z.boolean().default(true),
    aiTrainingPolicy: z.enum(["allow", "disallow"]).default("allow"),
    analyticsConfig: AnalyticsPublicConfigSchema.nullable().optional(),
    siteVisibility: z.enum(["public", "noindex"]).default("public"),
  })
  .strict();

export const BusinessProfileSnapshotSchema = z
  .object({
    businessName: z.string().trim().min(1).max(160),
    businessCategory: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((v) => v !== "ProfessionalService", {
        message: "ProfessionalService is deprecated in Schema.org; use LocalBusiness or a valid subtype",
      })
      .default("LocalBusiness"),
    description: z.string().max(1000).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    province: z.string().max(120).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    mapsUrl: HttpsUrlSchema.nullable().optional(),
    weekdayHours: PublicBusinessHoursSchema.shape.weekday.nullable().optional(),
    holidayHours: PublicBusinessHoursSchema.shape.holiday.optional(),
    serviceAreas: z.array(z.string().min(1).max(80)).max(20).default([]),
    whatsappE164: NormalizedPhoneSchema.nullable().optional(),
    phone: NormalizedPhoneSchema.nullable().optional(),
    email: EmailSchema.nullable().optional(),
    socialLinks: z.array(PublicSocialLinkSchema).max(10).default([]),
  })
  .strict();

export const MenuSnapshotSchema = z
  .object({
    location: MenuLocationSchema,
    items: z.array(PublicMenuItemLevel1Schema).max(20),
  })
  .strict();

export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;
export type PostSnapshot = z.infer<typeof PostSnapshotSchema>;
export type OfferingSnapshot = z.infer<typeof OfferingSnapshotSchema>;
export type SiteSettingsSnapshot = z.infer<typeof SiteSettingsSnapshotSchema>;
export type BusinessProfileSnapshot = z.infer<typeof BusinessProfileSnapshotSchema>;
export type MenuSnapshot = z.infer<typeof MenuSnapshotSchema>;

export interface ResourceSnapshotMap {
  readonly page: PageSnapshot;
  readonly post: PostSnapshot;
  readonly offering: OfferingSnapshot;
  readonly site_settings: SiteSettingsSnapshot;
  readonly business_profile: BusinessProfileSnapshot;
  readonly theme_config: ThemeConfigSnapshot;
  readonly menu: MenuSnapshot;
}

/**
 * Persisted JSON envelope written into `published_*` columns in `TenantStore`.
 * Strictly excludes draft-only fields.
 */
export interface PublishedSnapshotEnvelope<K extends PublishableResourceType> {
  readonly snapshotVersion: 1;
  readonly resourceType: K;
  readonly data: ResourceSnapshotMap[K];
  readonly publishedAt: number;
  readonly contentModifiedAt: number;
}

/**
 * Public-safe DTO returned by `extractPublishedSnapshot` and `getPublishedResource`.
 */
export interface PublishedResourceDto<K extends PublishableResourceType> {
  readonly resourceType: K;
  readonly resourceId: number | string;
  readonly version: number;
  readonly publishedAt: number | null;
  readonly contentModifiedAt: number | null;
  readonly data: ResourceSnapshotMap[K];
}

/**
 * Admin / preview-only DTO separating draft state from published snapshot.
 */
export interface AdminDraftResourceDto<K extends PublishableResourceType> {
  readonly resourceType: K;
  readonly resourceId: number | string;
  readonly status: ResourceLifecycleStatus | "configured";
  readonly version: number;
  readonly publishedAt: number | null;
  readonly contentModifiedAt: number | null;
  readonly updatedAt: number;
  readonly draft: ResourceSnapshotMap[K] | null;
  readonly draftMetadata: Readonly<Record<string, unknown>>;
  readonly published: ResourceSnapshotMap[K] | null;
  readonly hasUnpublishedChanges: boolean;
}

/**
 * Raw publication record shape consumed by `extractPublishedSnapshot` and
 * `extractDraftSnapshotForAdmin`.
 */
export interface RawPublishableRecord {
  readonly resourceId: number | string;
  readonly status?: ResourceLifecycleStatus | null;
  readonly deletedAt?: number | null;
  readonly draftJson?: string | null;
  readonly publishedJson?: string | null;
  readonly publishedAt?: number | null;
  readonly contentModifiedAt?: number | null;
  readonly version: number;
  readonly updatedAt?: number;
}

function toValidationError(resourceType: PublishableResourceType, err: unknown): PublicationValidationError {
  if (err instanceof PublicationValidationError) return err;
  if (err instanceof ThemeValidationError) {
    return new PublicationValidationError(err.message, err.fields);
  }
  if (err instanceof z.ZodError) {
    const fields: PublicationValidationField[] = err.issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : resourceType,
      code: issue.code.toUpperCase(),
      message: issue.message,
    }));
    return new PublicationValidationError(`Invalid ${resourceType} snapshot`, fields);
  }
  return new PublicationValidationError(
    `Invalid ${resourceType} snapshot: ${err instanceof Error ? err.message : "unknown error"}`,
  );
}

function sanitizeMenuItems(
  items: MenuSnapshot["items"],
): MenuSnapshot["items"] {
  return items.map((l1, i1) => ({
    ...l1,
    href: sanitizeNavigationHref(l1.href, `items[${i1}].href`),
    children: l1.children.map((l2, i2) => ({
      ...l2,
      href: sanitizeNavigationHref(l2.href, `items[${i1}].children[${i2}].href`),
      children: l2.children.map((l3, i3) => ({
        ...l3,
        href: sanitizeNavigationHref(l3.href, `items[${i1}].children[${i2}].children[${i3}].href`),
      })),
    })),
  }));
}

function sanitizePageSnapshot(data: PageSnapshot): PageSnapshot {
  return {
    ...data,
    sections: data.sections.map((section, idx) => ({
      ...section,
      bodyHtml: section.bodyHtml !== null ? sanitizePublishedHtmlFragment(section.bodyHtml) : null,
      ctaHref:
        section.ctaHref !== undefined && section.ctaHref !== null && section.ctaHref !== ""
          ? sanitizeNavigationHref(section.ctaHref, `sections[${idx}].ctaHref`)
          : section.ctaHref,
    })),
  };
}

function sanitizePostSnapshot(data: PostSnapshot): PostSnapshot {
  const cleanBody = sanitizeRichTextDoc(data.body);
  const cleanHtml =
    data.sanitizedHtml !== undefined
      ? sanitizeRichTextHtml(data.sanitizedHtml)
      : renderRichTextDocToSanitizedHtml(cleanBody);
  return {
    ...data,
    body: cleanBody,
    ...(data.sanitizedHtml !== undefined ? { sanitizedHtml: cleanHtml } : {}),
  };
}

function sanitizeOfferingSnapshot(data: OfferingSnapshot): OfferingSnapshot {
  const externalUrl =
    data.externalUrl !== undefined && data.externalUrl !== null
      ? sanitizeExternalLink(data.externalUrl).href
      : data.externalUrl;
  const description =
    typeof data.description === "string"
      ? sanitizePublishedHtmlFragment(data.description)
      : data.description;
  return {
    ...data,
    description,
    externalUrl,
  };
}

function parseSnapshotByType<K extends PublishableResourceType>(
  resourceType: K,
  sanitizedInput: unknown,
): ResourceSnapshotMap[K] {
  try {
    switch (resourceType) {
      case "page": {
        const parsed = PageSnapshotSchema.parse(sanitizedInput);
        return sanitizePageSnapshot(parsed) as ResourceSnapshotMap[K];
      }
      case "post": {
        const parsed = PostSnapshotSchema.parse(sanitizedInput);
        return sanitizePostSnapshot(parsed) as ResourceSnapshotMap[K];
      }
      case "offering": {
        const parsed = OfferingSnapshotSchema.parse(sanitizedInput);
        return sanitizeOfferingSnapshot(parsed) as ResourceSnapshotMap[K];
      }
      case "site_settings": {
        return SiteSettingsSnapshotSchema.parse(sanitizedInput) as ResourceSnapshotMap[K];
      }
      case "business_profile": {
        return BusinessProfileSnapshotSchema.parse(sanitizedInput) as ResourceSnapshotMap[K];
      }
      case "theme_config": {
        return validateThemeConfigSnapshot(sanitizedInput) as ResourceSnapshotMap[K];
      }
      case "menu": {
        const parsed = MenuSnapshotSchema.parse(sanitizedInput);
        return {
          ...parsed,
          items: sanitizeMenuItems(parsed.items),
        } as ResourceSnapshotMap[K];
      }
    }
  } catch (err) {
    throw toValidationError(resourceType, err);
  }
}

/**
 * Separates allowed draft-only editorial metadata (like `draftNotes` or `reviewComments`)
 * from the core publishable fields so draft saves can retain editorial notes while
 * published snapshots strip them completely.
 */
export function splitDraftPayload<K extends PublishableResourceType>(
  resourceType: K,
  input: unknown,
): {
  readonly data: ResourceSnapshotMap[K];
  readonly draftMetadata: Readonly<Record<string, unknown>>;
} {
  assertNoForbiddenTenantSelectors(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PublicationValidationError(`Expected object payload for ${resourceType} draft`);
  }

  const rawRecord = input as Record<string, unknown>;
  const draftMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawRecord)) {
    if (DRAFT_ONLY_FIELD_NAMES.has(key)) {
      draftMetadata[key] = value;
    }
  }

  const stripped = stripDraftOnlyFields(rawRecord);
  const data = parseSnapshotByType(resourceType, stripped);
  return { data, draftMetadata };
}

/**
 * Validates a draft payload for any publishable resource type.
 * Rejects forbidden tenant selectors, CSS injection, unsafe URLs, and schema violations (422).
 */
export function validateResourceDraft<K extends PublishableResourceType>(
  resourceType: K,
  input: unknown,
): ResourceSnapshotMap[K] {
  return splitDraftPayload(resourceType, input).data;
}

/**
 * Validates a complete resource payload for atomic publication.
 * Strictly strips any draft-only fields and enforces publish-time invariants (422).
 */
export function validateResourceForPublish<K extends PublishableResourceType>(
  resourceType: K,
  input: unknown,
): ResourceSnapshotMap[K] {
  assertNoForbiddenTenantSelectors(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PublicationValidationError(`Expected object payload for ${resourceType} publish`);
  }
  const stripped = stripDraftOnlyFields(input);
  const validated = parseSnapshotByType(resourceType, stripped);

  if (resourceType === "post") {
    const post = validated as PostSnapshot;
    if (post.body.blocks.length === 0) {
      throw new PublicationValidationError("Cannot publish a post with an empty body", [
        { field: "body.blocks", code: "EMPTY_BODY", message: "Published posts must have at least one content block" },
      ]);
    }
  }

  return validated;
}

/**
 * Builds the canonical immutable published snapshot envelope ready for storage
 * in `TenantStore`'s published snapshot column. Contains ZERO draft-only fields.
 */
export function buildPublishedSnapshot<K extends PublishableResourceType>(
  resourceType: K,
  input: unknown,
  meta: { readonly publishedAt: number; readonly contentModifiedAt: number },
): PublishedSnapshotEnvelope<K> {
  const data = validateResourceForPublish(resourceType, input);
  return {
    snapshotVersion: 1,
    resourceType,
    data,
    publishedAt: meta.publishedAt,
    contentModifiedAt: meta.contentModifiedAt,
  };
}

/**
 * Builds the persisted draft JSON payload (retaining editorial draft-only metadata
 * in an isolated `_draftMetadata` key so admin preview/editor can read it while
 * public extractors never touch draft columns).
 */
export function serializeDraftStoragePayload<K extends PublishableResourceType>(
  resourceType: K,
  input: unknown,
): {
  readonly json: string;
  readonly data: ResourceSnapshotMap[K];
  readonly draftMetadata: Readonly<Record<string, unknown>>;
} {
  const { data, draftMetadata } = splitDraftPayload(resourceType, input);
  const payload =
    Object.keys(draftMetadata).length > 0
      ? { snapshotVersion: 1, resourceType, data, _draftMetadata: draftMetadata }
      : { snapshotVersion: 1, resourceType, data };
  return {
    json: JSON.stringify(payload),
    data,
    draftMetadata,
  };
}

function isLifecycleResource(resourceType: PublishableResourceType): resourceType is LifecycleResourceType {
  return resourceType === "page" || resourceType === "post" || resourceType === "offering";
}

function unwrapStoredPayload(parsed: unknown): {
  readonly inner: unknown;
  readonly draftMetadata: Readonly<Record<string, unknown>>;
  readonly envelopePublishedAt?: number;
  readonly envelopeContentModifiedAt?: number;
} {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.snapshotVersion === 1 && "data" in obj) {
      const meta =
        obj._draftMetadata && typeof obj._draftMetadata === "object" && !Array.isArray(obj._draftMetadata)
          ? (obj._draftMetadata as Record<string, unknown>)
          : {};
      return {
        inner: obj.data,
        draftMetadata: meta,
        envelopePublishedAt: typeof obj.publishedAt === "number" ? obj.publishedAt : undefined,
        envelopeContentModifiedAt:
          typeof obj.contentModifiedAt === "number" ? obj.contentModifiedAt : undefined,
      };
    }
  }
  return { inner: parsed, draftMetadata: {} };
}

/**
 * Strictly extracts a public-safe published DTO from a stored record.
 *
 * Security & Draft-Isolation Invariants:
 * - Returns `null` if the record is missing, unpublished (`status !== "published"`),
 *   soft-deleted (`deletedAt != null`), or has no `publishedJson`.
 * - NEVER reads or falls back to `draftJson`.
 * - Strips any draft-only fields and re-validates through the strict public snapshot schema.
 */
export function extractPublishedSnapshot<K extends PublishableResourceType>(
  resourceType: K,
  record: RawPublishableRecord | null | undefined,
): PublishedResourceDto<K> | null {
  if (!record) return null;
  if (record.deletedAt !== undefined && record.deletedAt !== null) return null;
  if (isLifecycleResource(resourceType) && record.status !== "published") {
    return null;
  }
  if (!record.publishedJson || !record.publishedJson.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(record.publishedJson);
  } catch {
    return null;
  }

  const { inner, envelopePublishedAt, envelopeContentModifiedAt } = unwrapStoredPayload(parsed);
  const cleanData = parseSnapshotByType(resourceType, stripDraftOnlyFields(inner));

  return {
    resourceType,
    resourceId: record.resourceId,
    version: record.version,
    publishedAt: record.publishedAt ?? envelopePublishedAt ?? null,
    contentModifiedAt: record.contentModifiedAt ?? envelopeContentModifiedAt ?? null,
    data: cleanData,
  };
}

/**
 * Extracts admin/preview state separating current draft from live published snapshot.
 * MUST ONLY be called from authenticated admin/preview paths (never public routes).
 */
export function extractDraftSnapshotForAdmin<K extends PublishableResourceType>(
  resourceType: K,
  record: RawPublishableRecord | null | undefined,
): AdminDraftResourceDto<K> | null {
  if (!record) return null;

  let draft: ResourceSnapshotMap[K] | null = null;
  let draftMetadata: Readonly<Record<string, unknown>> = {};

  if (record.draftJson && record.draftJson.trim()) {
    try {
      const parsed = JSON.parse(record.draftJson);
      const unwrapped = unwrapStoredPayload(parsed);
      const split = splitDraftPayload(resourceType, unwrapped.inner);
      draft = split.data;
      draftMetadata = { ...unwrapped.draftMetadata, ...split.draftMetadata };
    } catch {
      draft = null;
    }
  }

  const publishedDto = extractPublishedSnapshot(resourceType, record);
  const published = publishedDto ? publishedDto.data : null;

  const hasUnpublishedChanges =
    draft !== null &&
    (published === null || JSON.stringify(draft) !== JSON.stringify(published));

  return {
    resourceType,
    resourceId: record.resourceId,
    status: isLifecycleResource(resourceType)
      ? (record.status ?? "draft")
      : "configured",
    version: record.version,
    publishedAt: record.publishedAt ?? null,
    contentModifiedAt: record.contentModifiedAt ?? null,
    updatedAt: record.updatedAt ?? 0,
    draft,
    draftMetadata,
    published,
    hasUnpublishedChanges,
  };
}
