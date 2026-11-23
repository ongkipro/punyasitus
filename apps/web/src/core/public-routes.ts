import {
  classifySurfaceHost,
  normalizeHost,
  PLATFORM_HOSTS,
  type SurfaceKind,
} from "@punyasitus/core";
import {
  getOfferingPublicBasePath,
  getOfferingPublicPath,
  getOfferingSlugNamespace,
  validateOfferingAttributes,
  type CatalogOfferingType,
  type ProductAttributes,
  type ServiceAttributes,
  type TourAttributes,
  type VehicleAttributes,
} from "@punyasitus/core/catalog/index";
import {
  calculateReadingTimeMinutes,
  extractPublishedSnapshot,
  extractTocFromSanitizedHtml,
  renderRichTextDocToSanitizedHtml,
  sanitizeNavigationHref,
  sanitizePublishedHtmlFragment,
  type OfferingSnapshot,
  type PageLayoutMode,
  type PageSeoOverrides,
  type PageSnapshot,
  type PublishedResourceDto,
  type TocHeadingEntry,
} from "@punyasitus/core/content/index";
import { validateExternalLink } from "@punyasitus/core/link-sanitizer";
import {
  assertTenantR2Key,
  type MediaVariantsManifest,
} from "@punyasitus/core/media/index";
import {
  buildOgImageCandidateFromMediaRecord,
  DEFAULT_MEDIA_CDN_ORIGIN,
  generateOpenGraphMetadata,
  validateTrustedMediaOrigin,
  type OgImageCandidate,
  type SocialMetadataDto,
} from "@punyasitus/core/og-generator";
import {
  generateSchemaGraph,
  type SchemaBreadcrumbItemInput,
  type SchemaBusinessProfileInput,
  type SchemaFaqItemInput,
  type SchemaGraphDocument,
  type SchemaImageInput,
} from "@punyasitus/core/schema-generator";
import {
  MAX_PAGINATION_PAGE,
  resolveVerifiedCanonicalOrigin,
  sanitizeSeoText,
  type PublishedSeoDecisionInput,
  type ResourceSeoOverrides,
  type VerifiedCanonicalOrigin,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
import type { SlugNamespace } from "@punyasitus/core/slug/index";
import type { BlogLatestSectionConfig } from "@punyasitus/core/theme/index";
import {
  buildWhatsAppUrl,
  formatOfferingPrice,
  normalizeIndonesianWhatsAppNumber,
} from "@punyasitus/core/wa-dispatcher";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { findResourceSlug } from "@punyasitus/db/identifiers/index";
import { resolveTenantByHost } from "@punyasitus/db/routing/index";
import { CACHE_VERSION_HEADER_NAME } from "./cache.ts";
import {
  loadPublishedTenantShellData,
  type TenantShellData,
} from "./public-data.ts";
import {
  formatIdrPlain,
  type SectionOfferingItem,
} from "./section-registry.ts";
import {
  createStatePageResponse,
  type TenantContext,
} from "./tenant.ts";

/**
 * Shared Public Route Resolver & Published View-Model Loader
 * (REQ-018, REQ-008, REQ-009, REQ-012, REQ-026, REQ-061, PLAN §7.1, §7.3 & §15, TASK-036).
 *
 * Runtime-neutral: imports zero `cloudflare:workers` globals so it executes identically inside:
 * - Astro SSR pages (`apps/web/src/pages/**`)
 * - Local `workerd` integration tests with real `PLATFORM_DB` D1 + two isolated `TenantStore` DOs
 * - Runtime-neutral Node unit tests
 *
 * Security & Isolation Guarantees:
 * - Resolves tenant STRICTLY from verified public host context (`TASK-002`); returns neutral `404`
 *   on unknown/platform/destroyed hosts, `503` on suspended/recovery/unavailable, and `301` on
 *   verified alias hosts.
 * - Reads ONLY frozen published snapshots via `extractPublishedSnapshot` & `loadPublishedTenantShellData`;
 *   draft edits, draft rows, unpublished rows, and trashed rows NEVER leak.
 * - Emits ONE single-hop `308 Permanent Redirect` for former slugs (`resource_slugs.is_current = 0`)
 *   ONLY while the target resource is currently published, and `404` after unpublish or trash.
 * - Canonicalizes homepage slug `/{homeSlug}` with `308` to `/`.
 * - Normalizes `?page=1` with `301` to clean base path; out-of-range/malformed pages return `404`.
 * - Emits zero numeric IDs in any public URL.
 */

export const DEFAULT_BLOG_PAGE_SIZE = 9 as const;
export const DEFAULT_OFFERING_PAGE_SIZE = 9 as const;
export const MAX_PUBLIC_PAGE_SIZE = 48 as const;
export const PUBLIC_CACHE_MAX_AGE_SECONDS = 60 as const;

const SLUG_SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUMERIC_ID_SEGMENT_RE = /^\d+$/;
const SQL_IN_BATCH_SIZE = 80 as const;

export interface OfferingRouteDescriptor {
  readonly offeringType: CatalogOfferingType;
  readonly prefix: string;
  readonly namespace: SlugNamespace;
  readonly singularLabel: string;
  readonly pluralLabel: string;
  readonly listingHeading: string;
  readonly listingDescription: string;
  readonly emptyHeading: string;
  readonly emptyBody: string;
  readonly backLabel: string;
  readonly detailCtaDefaultLabel: string;
}

export const OFFERING_ROUTE_META: Readonly<Record<CatalogOfferingType, OfferingRouteDescriptor>> =
  Object.freeze({
    service: {
      offeringType: "service",
      prefix: "/layanan",
      namespace: "layanan",
      singularLabel: "Layanan",
      pluralLabel: "Layanan",
      listingHeading: "Daftar Layanan",
      listingDescription:
        "Jelajahi daftar layanan resmi beserta rincian cakupan, estimasi biaya transparan, dan konsultasi langsung.",
      emptyHeading: "Belum ada layanan yang diterbitkan",
      emptyBody:
        "Daftar layanan akan tampil di halaman ini setelah pemilik usaha menerbitkan informasi layanan.",
      backLabel: "Semua Layanan",
      detailCtaDefaultLabel: "Konsultasi via WhatsApp",
    },
    product: {
      offeringType: "product",
      prefix: "/produk",
      namespace: "produk",
      singularLabel: "Produk",
      pluralLabel: "Produk",
      listingHeading: "Katalog Produk",
      listingDescription:
        "Lihat katalog produk yang tersedia lengkap dengan spesifikasi, harga Rupiah transparan, dan tautan pemesanan.",
      emptyHeading: "Belum ada produk yang diterbitkan",
      emptyBody:
        "Katalog produk akan tampil di halaman ini setelah pemilik usaha menerbitkan item katalog.",
      backLabel: "Semua Produk",
      detailCtaDefaultLabel: "Pesan via WhatsApp",
    },
    tour: {
      offeringType: "tour",
      prefix: "/tour",
      namespace: "tour",
      singularLabel: "Paket Tur",
      pluralLabel: "Paket Tur",
      listingHeading: "Daftar Paket Tur & Perjalanan",
      listingDescription:
        "Informasi paket perjalanan lengkap dengan durasi, rencana perjalanan harian, fasilitas, dan jadwal keberangkatan.",
      emptyHeading: "Belum ada paket tur yang diterbitkan",
      emptyBody:
        "Daftar paket perjalanan akan tampil di halaman ini setelah biro menerbitkan penawaran terbaru.",
      backLabel: "Semua Paket Tur",
      detailCtaDefaultLabel: "Tanya Paket via WhatsApp",
    },
    vehicle: {
      offeringType: "vehicle",
      prefix: "/kendaraan",
      namespace: "kendaraan",
      singularLabel: "Kendaraan",
      pluralLabel: "Kendaraan",
      listingHeading: "Daftar Unit Kendaraan",
      listingDescription:
        "Pilihan unit kendaraan lengkap dengan spesifikasi teknis, status ketersediaan unit, dan informasi harga transparan.",
      emptyHeading: "Belum ada kendaraan yang diterbitkan",
      emptyBody:
        "Unit kendaraan akan tampil di halaman ini setelah showroom menerbitkan daftar unit.",
      backLabel: "Semua Kendaraan",
      detailCtaDefaultLabel: "Hubungi Sales via WhatsApp",
    },
  });

// ---------------------------------------------------------------------------
// Public Route Dependency & Resolution Types
// ---------------------------------------------------------------------------

export interface PublicRouteDeps {
  readonly surface?: SurfaceKind;
  readonly host?: string;
  readonly tenant?: TenantContext | null;
  readonly tenantDb?: D1Database | null;
  readonly platformDb?: D1Database | null;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly platformDomain?: string;
  readonly saasZone?: string;
  readonly mediaPublicBaseUrl?: string | null;
  readonly nowMs?: number;
  readonly bypassHostCache?: boolean;
}

export interface PublicBreadcrumbItem {
  readonly label: string;
  readonly href: string | null;
}

export interface PublicResolvedImage {
  readonly id: number;
  readonly url: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
  readonly bytes: number;
  readonly r2Key: string;
  readonly ogCandidate: OgImageCandidate | null;
}

export interface PublicPaginationLink {
  readonly page: number;
  readonly href: string;
  readonly current: boolean;
}

export interface PublicPaginationState {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly offset: number;
  readonly prevHref: string | null;
  readonly nextHref: string | null;
  readonly pageLinks: readonly PublicPaginationLink[];
}

export type PublicPaginationDecision =
  | {
      readonly kind: "redirect_page_one";
      readonly status: 301;
      readonly location: string;
    }
  | {
      readonly kind: "not_found";
      readonly reason: "invalid_pagination" | "out_of_range_pagination";
    }
  | {
      readonly kind: "ok";
      readonly pagination: PublicPaginationState;
    };

export interface PublicFloatingWaModel {
  readonly phone: string | null;
  readonly businessName: string;
  readonly operatingHours: string | null;
  readonly holidayHours: string | null;
  readonly primaryOrigin: string;
  readonly canonicalPath: string;
  readonly itemTitle: string;
  readonly itemPrice?: string;
  readonly greetingMessage: string;
}

export interface PublicRouteHttpMeta {
  readonly status: 200 | 404;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PublicBrandedNotFoundResult {
  readonly kind: "not_found";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly pageTitle: string;
  readonly heading: string;
  readonly message: string;
  readonly seoMetadata: SocialMetadataDto;
  readonly floatingWa: PublicFloatingWaModel;
}

export interface PublicImmediateResponseResult {
  readonly kind: "response";
  readonly response: Response;
  readonly reason:
    | "unknown_host"
    | "platform_surface"
    | "destroyed"
    | "suspended"
    | "recovery"
    | "unavailable"
    | "alias_redirect"
    | "former_slug_redirect"
    | "homepage_slug_redirect"
    | "mixed_case_slug_redirect"
    | "page_one_redirect";
}

export interface PublicPageRenderResult {
  readonly kind: "page";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly isHomepage: boolean;
  readonly layoutMode: PageLayoutMode;
  readonly pageTitle: string;
  readonly page: PageSnapshot | null;
  readonly fallbackOfferings: readonly SectionOfferingItem[];
  readonly fallbackPosts: BlogLatestSectionConfig["posts"];
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly floatingWa: PublicFloatingWaModel;
}

export interface PublicBlogListItem {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly authorName: string | null;
  readonly categoryName: string | null;
  readonly publishedAtIso: string | null;
  readonly publishedDateLabel: string | null;
  readonly readingTimeMinutes: number;
  readonly coverImage: PublicResolvedImage | null;
}

export interface PublicBlogListingRenderResult {
  readonly kind: "blog_listing";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly pageTitle: string;
  readonly heading: string;
  readonly description: string;
  readonly items: readonly PublicBlogListItem[];
  readonly pagination: PublicPaginationState;
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly floatingWa: PublicFloatingWaModel;
}

export interface PublicBlogDetailRenderResult {
  readonly kind: "blog_detail";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly pageTitle: string;
  readonly post: {
    readonly slug: string;
    readonly href: string;
    readonly title: string;
    readonly excerpt: string | null;
    readonly sanitizedHtml: string;
    readonly toc: readonly TocHeadingEntry[];
    readonly showToc: boolean;
    readonly readingTimeMinutes: number;
    readonly authorName: string | null;
    readonly authorBio: string | null;
    readonly categoryName: string | null;
    readonly categoryNames: readonly string[];
    readonly tagNames: readonly string[];
    readonly publishedAtIso: string | null;
    readonly publishedDateLabel: string | null;
    readonly modifiedAtIso: string | null;
    readonly modifiedDateLabel: string | null;
    readonly coverImage: PublicResolvedImage | null;
  };
  readonly relatedPosts: readonly PublicBlogListItem[];
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly floatingWa: PublicFloatingWaModel;
}

export interface PublicOfferingCta {
  readonly mode: OfferingSnapshot["ctaMode"];
  readonly label: string;
  readonly href: string;
  readonly isExternal: boolean;
  readonly isWhatsApp: boolean;
  readonly helperNote: string | null;
}

export interface VehicleCreditEstimateRow {
  readonly dpPercent: number;
  readonly dpAmountIdr: number;
  readonly dpLabel: string;
  readonly principalAmountIdr: number;
  readonly installments: readonly {
    readonly tenorMonths: number;
    readonly monthlyAmountIdr: number;
    readonly monthlyLabel: string;
  }[];
}

export interface PublicOfferingListItem {
  readonly offeringType: CatalogOfferingType;
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly summary: string | null;
  readonly categoryName: string | null;
  readonly badge: string | null;
  readonly unitStatus: OfferingSnapshot["unitStatus"] | null;
  readonly unitStatusLabel: string | null;
  readonly priceMode: OfferingSnapshot["priceMode"];
  readonly priceText: string;
  readonly originalPriceText: string | null;
  readonly negotiable: boolean;
  readonly metaLine: string | null;
  readonly coverImage: PublicResolvedImage | null;
  readonly cta: PublicOfferingCta;
}

export interface PublicOfferingListingRenderResult {
  readonly kind: "offering_listing";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly descriptor: OfferingRouteDescriptor;
  readonly pageTitle: string;
  readonly items: readonly PublicOfferingListItem[];
  readonly pagination: PublicPaginationState;
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly floatingWa: PublicFloatingWaModel;
}

export interface PublicOfferingDetailRenderResult {
  readonly kind: "offering_detail";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly descriptor: OfferingRouteDescriptor;
  readonly pageTitle: string;
  readonly offering: {
    readonly offeringType: CatalogOfferingType;
    readonly slug: string;
    readonly href: string;
    readonly title: string;
    readonly summary: string | null;
    readonly descriptionHtml: string | null;
    readonly categoryNames: readonly string[];
    readonly badge: string | null;
    readonly unitStatus: OfferingSnapshot["unitStatus"] | null;
    readonly unitStatusLabel: string | null;
    readonly priceMode: OfferingSnapshot["priceMode"];
    readonly priceText: string;
    readonly originalPriceText: string | null;
    readonly negotiable: boolean;
    readonly coverImage: PublicResolvedImage | null;
    readonly galleryImages: readonly PublicResolvedImage[];
    readonly cta: PublicOfferingCta;
    readonly fallbackContactHref: string | null;
    readonly attributes: OfferingSnapshot["attributes"];
    readonly serviceAttributes: ServiceAttributes | null;
    readonly productAttributes: ProductAttributes | null;
    readonly tourAttributes: TourAttributes | null;
    readonly vehicleAttributes: VehicleAttributes | null;
    readonly vehicleCreditRows: readonly VehicleCreditEstimateRow[];
    readonly publishedDateLabel: string | null;
    readonly modifiedDateLabel: string | null;
  };
  readonly relatedOfferings: readonly PublicOfferingListItem[];
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly floatingWa: PublicFloatingWaModel;
}

export type PublicPageRouteResult =
  | PublicImmediateResponseResult
  | PublicBrandedNotFoundResult
  | PublicPageRenderResult;

export type PublicBlogListingRouteResult =
  | PublicImmediateResponseResult
  | PublicBrandedNotFoundResult
  | PublicBlogListingRenderResult;

export type PublicBlogDetailRouteResult =
  | PublicImmediateResponseResult
  | PublicBrandedNotFoundResult
  | PublicBlogDetailRenderResult;

export type PublicOfferingListingRouteResult =
  | PublicImmediateResponseResult
  | PublicBrandedNotFoundResult
  | PublicOfferingListingRenderResult;

export type PublicOfferingDetailRouteResult =
  | PublicImmediateResponseResult
  | PublicBrandedNotFoundResult
  | PublicOfferingDetailRenderResult;

// ---------------------------------------------------------------------------
// Raw SQLite Row Types
// ---------------------------------------------------------------------------

interface RawPageRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly is_homepage: number;
  readonly published_sections_json: string | null;
  readonly seo_json: string | null;
  readonly status: "draft" | "published" | "trashed";
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawPostRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly published_body_json: string | null;
  readonly primary_category_id: number | null;
  readonly author_id: number | null;
  readonly cover_media_id: number | null;
  readonly reading_time_minutes: number;
  readonly show_toc: number;
  readonly seo_json: string | null;
  readonly status: "draft" | "published" | "trashed";
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawOfferingRow {
  readonly id: number;
  readonly offering_type: CatalogOfferingType;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly cover_media_id: number | null;
  readonly gallery_media_ids_json: string;
  readonly video_media_id: number | null;
  readonly youtube_video_id: string | null;
  readonly price_mode: OfferingSnapshot["priceMode"];
  readonly price: number | null;
  readonly price_max: number | null;
  readonly negotiable: number;
  readonly original_amount: number | null;
  readonly badge: string | null;
  readonly cta_mode: OfferingSnapshot["ctaMode"];
  readonly external_url: string | null;
  readonly unit_status: OfferingSnapshot["unitStatus"] | null;
  readonly attributes_version: number;
  readonly attributes_json: string;
  readonly published_snapshot_json: string | null;
  readonly seo_json: string | null;
  readonly status: "draft" | "published" | "trashed";
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawMediaRow {
  readonly id: number;
  readonly kind: string;
  readonly r2_key: string;
  readonly mime_type: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt_text: string;
  readonly variants_json: string | null;
  readonly status: string;
  readonly deleted_at?: number | null;
}

interface RawAuthorRow {
  readonly id: number;
  readonly name: string;
  readonly bio: string | null;
}

interface RawTaxonomyRow {
  readonly id: number;
  readonly taxonomy_type: string;
  readonly slug: string;
  readonly name: string;
}

interface ResolvedPublicTenantScope {
  readonly tenant: TenantContext;
  readonly tenantDb: D1Database;
  readonly seoTenant: VerifiedTenantHostInput;
  readonly verifiedOrigin: VerifiedCanonicalOrigin;
  readonly mediaBaseOrigin: string;
}

type TenantScopeResolution =
  | { readonly kind: "ok"; readonly scope: ResolvedPublicTenantScope }
  | { readonly kind: "response"; readonly result: PublicImmediateResponseResult };

// ---------------------------------------------------------------------------
// Pure Helpers (Pagination, Clean URLs, Formatting, Credit Math, SEO)
// ---------------------------------------------------------------------------

/**
 * Checks whether any path segment of a URL or pathname is purely numeric (e.g., `/blog/42`).
 * Public URLs MUST NEVER contain numeric IDs (`REQ-061`, `PLAN §7.1`).
 */
export function containsNumericIdPathSegment(urlOrPath: string): boolean {
  let pathname = urlOrPath;
  if (/^https?:\/\//i.test(urlOrPath)) {
    try {
      pathname = new URL(urlOrPath).pathname;
    } catch {
      return false;
    }
  }
  const clean = pathname.split("?")[0]?.split("#")[0] ?? "";
  const segments = clean.split("/").filter(Boolean);
  return segments.some((seg) => NUMERIC_ID_SEGMENT_RE.test(seg));
}

const SAFE_EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export type InspectedSlugParam =
  | { readonly kind: "invalid" }
  | { readonly kind: "canonical"; readonly slug: string }
  | { readonly kind: "mixed_case"; readonly rawSlug: string; readonly canonicalSlug: string };

/**
 * Inspects a single dynamic slug parameter, distinguishing:
 * - `"canonical"`: already valid lowercase canonical slug
 * - `"mixed_case"`: valid slug containing uppercase characters (eligible for single-hop `308` to lowercase)
 * - `"invalid"`: empty, multi-segment, > 80 chars, or disallowed characters
 */
export function inspectSingleSlugParam(rawSlug: string | undefined | null): InspectedSlugParam {
  if (typeof rawSlug !== "string") return { kind: "invalid" };
  const stripped = rawSlug.trim().replace(/^\/+|\/+$/g, "");
  if (!stripped || stripped.includes("/") || stripped.length > 80) {
    return { kind: "invalid" };
  }
  const lower = stripped.toLowerCase();
  if (!SLUG_SEGMENT_RE.test(lower)) {
    return { kind: "invalid" };
  }
  if (stripped !== lower) {
    return { kind: "mixed_case", rawSlug: stripped, canonicalSlug: lower };
  }
  return { kind: "canonical", slug: lower };
}

/**
 * Normalizes a single dynamic slug route parameter.
 * Returns `null` when empty, multi-segment, malformed, or containing unsafe characters.
 */
export function normalizeSingleSlugParam(rawSlug: string | undefined | null): string | null {
  const inspected = inspectSingleSlugParam(rawSlug);
  if (inspected.kind === "invalid") return null;
  return inspected.kind === "canonical" ? inspected.slug : inspected.canonicalSlug;
}

/**
 * Validates and preserves safe query parameters for `308` redirects (`PLAN §7.1` & `§15.2`),
 * rejecting control characters, CR/LF header-injection attempts, and oversized keys/values.
 */
export function buildPreservedRedirectQuery(searchParams: URLSearchParams | null | undefined): string {
  if (!searchParams) return "";
  const safe = new URLSearchParams();
  let count = 0;
  for (const [rawKey, rawValue] of searchParams.entries()) {
    if (count >= 24) break;
    if (rawKey.length === 0 || rawKey.length > 64 || rawValue.length > 256) continue;
    let unsafe = false;
    for (let i = 0; i < rawKey.length; i += 1) {
      const c = rawKey.charCodeAt(i);
      if (c <= 0x1f || c === 0x7f || c === 0x20) {
        unsafe = true;
        break;
      }
    }
    if (unsafe) continue;
    for (let i = 0; i < rawValue.length; i += 1) {
      const c = rawValue.charCodeAt(i);
      if (c <= 0x1f || c === 0x7f) {
        unsafe = true;
        break;
      }
    }
    if (unsafe) continue;
    safe.append(rawKey, rawValue);
    count += 1;
  }
  const encoded = safe.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/**
 * Strictly validates an email address before constructing a `mailto:` URI
 * (rejects whitespace, newlines, control chars, angle brackets, query/fragment injection).
 */
export function sanitizeSafeMailtoAddress(rawEmail: string | null | undefined): string | null {
  if (typeof rawEmail !== "string") return null;
  const trimmed = rawEmail.trim();
  if (!trimmed || trimmed.length > 254) return null;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  if (/[<>"'\\?&#,;]/.test(trimmed)) return null;
  if (!SAFE_EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function buildSafeMailtoHref(rawEmail: string | null | undefined, subject?: string): string | null {
  const safeEmail = sanitizeSafeMailtoAddress(rawEmail);
  if (!safeEmail) return null;
  const encodedAddr = encodeURIComponent(safeEmail).replace(/%40/g, "@");
  if (subject && subject.trim().length > 0) {
    return `mailto:${encodedAddr}?subject=${encodeURIComponent(subject.trim())}`;
  }
  return `mailto:${encodedAddr}`;
}

/**
 * Normalizes and validates `?page=N` query pagination for public archives (`/blog`, `/layanan`, etc.):
 * - `?page=1` -> `301 Moved Permanently` to clean `${origin}${basePath}`
 * - Duplicate `?page=`, non-integer, zero, negative, leading-zero, or `> MAX_PAGINATION_PAGE` -> `404`
 * - `page > totalPages` (including `page >= 2` on an empty 0-item archive) -> `404`
 * - Valid `page = 1` or `2..totalPages` -> bounded offset/limit + crawlable `prevHref`/`nextHref`/`pageLinks`
 */
export function parsePublicPaginationQuery(params: {
  readonly searchParams: URLSearchParams;
  readonly basePath: string;
  readonly origin: string;
  readonly totalItems: number;
  readonly pageSize?: number;
}): PublicPaginationDecision {
  const cleanBase =
    params.basePath.length > 1 && params.basePath.endsWith("/")
      ? params.basePath.slice(0, -1)
      : params.basePath || "/";
  const cleanOrigin = params.origin.replace(/\/+$/, "");
  const pageSize = Math.max(
    1,
    Math.min(MAX_PUBLIC_PAGE_SIZE, Math.floor(params.pageSize ?? DEFAULT_BLOG_PAGE_SIZE)),
  );
  const totalItems = Math.max(0, Math.floor(params.totalItems));
  const totalPages = totalItems === 0 ? 1 : Math.ceil(totalItems / pageSize);

  const pageValues = params.searchParams.getAll("page");
  let page = 1;

  if (pageValues.length > 1) {
    return { kind: "not_found", reason: "invalid_pagination" };
  }

  if (pageValues.length === 1) {
    const raw = (pageValues[0] ?? "").trim();
    if (!/^[1-9]\d*$/.test(raw)) {
      return { kind: "not_found", reason: "invalid_pagination" };
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGINATION_PAGE) {
      return { kind: "not_found", reason: "invalid_pagination" };
    }
    if (parsed === 1) {
      return {
        kind: "redirect_page_one",
        status: 301,
        location: `${cleanOrigin}${cleanBase}`,
      };
    }
    page = parsed;
  }

  if (page > totalPages || (totalItems === 0 && page > 1)) {
    return { kind: "not_found", reason: "out_of_range_pagination" };
  }

  const prevHref =
    page <= 1 ? null : page === 2 ? cleanBase : `${cleanBase}?page=${page - 1}`;
  const nextHref = page < totalPages ? `${cleanBase}?page=${page + 1}` : null;

  const pageLinks: PublicPaginationLink[] = [];
  if (totalPages > 1) {
    const windowStart = Math.max(1, page - 2);
    const windowEnd = Math.min(totalPages, page + 2);
    const pagesToShow = new Set<number>([1, totalPages]);
    for (let p = windowStart; p <= windowEnd; p += 1) {
      pagesToShow.add(p);
    }
    const sorted = Array.from(pagesToShow).sort((a, b) => a - b);
    for (const p of sorted) {
      pageLinks.push({
        page: p,
        href: p === 1 ? cleanBase : `${cleanBase}?page=${p}`,
        current: p === page,
      });
    }
  }

  return {
    kind: "ok",
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      offset: (page - 1) * pageSize,
      prevHref,
      nextHref,
      pageLinks,
    },
  };
}

/**
 * Formats an offering price in localized Indonesian Rupiah per REQ-016.
 * `on_request` NEVER reads as free ("Hubungi untuk harga").
 */
export function formatPublicOfferingPrice(offering: {
  readonly priceMode: OfferingSnapshot["priceMode"];
  readonly price?: number | null;
  readonly priceMax?: number | null;
  readonly negotiable?: boolean;
}): string {
  switch (offering.priceMode) {
    case "on_request":
      return formatOfferingPrice({ model: "on_request" });
    case "fixed":
      return formatOfferingPrice({
        model: "fixed",
        amountIdr: offering.price ?? 0,
        negotiable: Boolean(offering.negotiable),
      });
    case "from":
      return formatOfferingPrice({
        model: "from",
        amountIdr: offering.price ?? 0,
        negotiable: Boolean(offering.negotiable),
      });
    case "range": {
      const min = offering.price ?? 0;
      const max = Math.max(min, offering.priceMax ?? min);
      return formatOfferingPrice({
        model: "range",
        minAmountIdr: min,
        maxAmountIdr: max,
        negotiable: Boolean(offering.negotiable),
      });
    }
  }
}

export function getVehicleUnitStatusLabel(
  status: OfferingSnapshot["unitStatus"] | null | undefined,
): string | null {
  if (status === "available") return "Tersedia";
  if (status === "booked") return "Dipesan";
  if (status === "sold") return "Terjual";
  return null;
}

/**
 * Static integer Rupiah credit-estimate table for `vehicle` offerings (`DESIGN.md §7`, `REQ-079`).
 * Zero floating-point drift, zero client JS. Shown ONLY when `unitStatus === "available"`,
 * `priceMode === "fixed"`, `price > 0`, and `creditEstimateEnabled` + `creditEstimateConfig` exist.
 */
export function computeVehicleCreditEstimateRows(
  priceIdr: number | null | undefined,
  config: VehicleAttributes["creditEstimateConfig"] | null | undefined,
): readonly VehicleCreditEstimateRow[] {
  if (
    typeof priceIdr !== "number" ||
    !Number.isSafeInteger(priceIdr) ||
    priceIdr <= 0 ||
    !config ||
    config.dpPercents.length === 0 ||
    config.tenorMonths.length === 0
  ) {
    return [];
  }

  const dpList = [...new Set(config.dpPercents)].sort((a, b) => a - b);
  const tenorList = [...new Set(config.tenorMonths)].sort((a, b) => a - b);

  return dpList.map((dpPercent) => {
    const dpAmountIdr = Math.round((priceIdr * dpPercent) / 100);
    const principalAmountIdr = Math.max(0, priceIdr - dpAmountIdr);

    const installments = tenorList.map((tenorMonths) => {
      // Integer flat-rate estimation:
      // totalInterest = principal * annualFlatRateBps * tenorMonths / (10_000 * 12)
      const totalInterest = Math.round(
        (principalAmountIdr * config.annualFlatRateBps * tenorMonths) / 120_000,
      );
      const totalPayable = principalAmountIdr + totalInterest;
      // Round monthly installment up to nearest Rp 1.000 for clean consumer readability
      const rawMonthly = Math.ceil(totalPayable / tenorMonths);
      const monthlyAmountIdr = Math.ceil(rawMonthly / 1000) * 1000;
      return {
        tenorMonths,
        monthlyAmountIdr,
        monthlyLabel: `${formatIdrPlain(monthlyAmountIdr)} / bln`,
      };
    });

    return {
      dpPercent,
      dpAmountIdr,
      dpLabel: `${dpPercent}% (${formatIdrPlain(dpAmountIdr)})`,
      principalAmountIdr,
      installments,
    };
  });
}

/**
 * Resolves a zero-JS-usable offering CTA (`whatsapp`, `external_link`, `inquiry`, `book`)
 * using verified primary origin & canonical path (never visitor query strings).
 */
export function resolvePublicOfferingCta(
  offering: Pick<
    OfferingSnapshot,
    | "offeringType"
    | "slug"
    | "title"
    | "priceMode"
    | "price"
    | "priceMax"
    | "negotiable"
    | "ctaMode"
    | "externalUrl"
    | "ctaLabel"
    | "whatsappOverride"
    | "whatsappTemplate"
  >,
  options: {
    readonly primaryOrigin: string;
    readonly tenantWhatsappE164?: string | null;
    readonly tenantEmail?: string | null;
    readonly tenantPhone?: string | null;
    readonly isDetailPage?: boolean;
  },
): PublicOfferingCta {
  const descriptor = OFFERING_ROUTE_META[offering.offeringType];
  const detailPath = getOfferingPublicPath(offering.offeringType, offering.slug);
  const priceText = formatPublicOfferingPrice(offering);
  const customLabel =
    typeof offering.ctaLabel === "string" && offering.ctaLabel.trim().length > 0
      ? offering.ctaLabel.trim()
      : null;

  const buildWaFallback = (label: string, helperNote: string | null): PublicOfferingCta | null => {
    const basePhone = options.tenantWhatsappE164 ?? offering.whatsappOverride ?? null;
    if (!basePhone) return null;
    try {
      const wa = buildWhatsAppUrl({
        tenantPhone: basePhone,
        itemPhoneOverride: offering.whatsappOverride ?? undefined,
        template: offering.whatsappTemplate ?? undefined,
        itemTitle: offering.title,
        itemPrice: priceText,
        primaryOrigin: options.primaryOrigin,
        canonicalPath: detailPath,
      });
      return {
        mode: offering.ctaMode,
        label: customLabel ?? label,
        href: wa.url,
        isExternal: true,
        isWhatsApp: true,
        helperNote,
      };
    } catch {
      return null;
    }
  };

  if (offering.ctaMode === "whatsapp") {
    const waCta = buildWaFallback(
      options.isDetailPage ? descriptor.detailCtaDefaultLabel : "Tanya via WhatsApp",
      "Membuka WhatsApp dengan pesan terisi otomatis",
    );
    if (waCta) return waCta;
    if (options.tenantPhone) {
      return {
        mode: "whatsapp",
        label: customLabel ?? "Hubungi via Telepon",
        href: `tel:${options.tenantPhone.replace(/[^\d+]/g, "")}`,
        isExternal: false,
        isWhatsApp: false,
        helperNote: null,
      };
    }
    return {
      mode: "whatsapp",
      label: customLabel ?? "Lihat Detail",
      href: detailPath,
      isExternal: false,
      isWhatsApp: false,
      helperNote: null,
    };
  }

  if (offering.ctaMode === "external_link" && offering.externalUrl) {
    const validated = validateExternalLink(offering.externalUrl);
    if (validated.ok) {
      return {
        mode: "external_link",
        label: customLabel ?? (options.isDetailPage ? "Buka Tautan Penawaran" : "Lihat Penawaran"),
        href: validated.link.href,
        isExternal: true,
        isWhatsApp: false,
        helperNote: "Membuka tautan eksternal resmi di tab baru",
      };
    }
  }

  if (offering.ctaMode === "book") {
    const waBook = buildWaFallback(
      "Ajukan Jadwal Konsultasi",
      "Permintaan jadwal dikonfirmasi langsung oleh tim kami (bukan penguncian slot otomatis).",
    );
    if (waBook) return waBook;
    const mailtoHref = buildSafeMailtoHref(options.tenantEmail, `Pengajuan Jadwal: ${offering.title}`);
    if (mailtoHref) {
      return {
        mode: "book",
        label: customLabel ?? "Ajukan Jadwal via Email",
        href: mailtoHref,
        isExternal: false,
        isWhatsApp: false,
        helperNote: "Permintaan jadwal dikonfirmasi langsung oleh tim kami.",
      };
    }
    return {
      mode: "book",
      label: customLabel ?? "Ajukan Jadwal",
      href: options.isDetailPage ? "/#kontak" : detailPath,
      isExternal: false,
      isWhatsApp: false,
      helperNote: "Permintaan jadwal dikonfirmasi langsung oleh tim kami.",
    };
  }

  // `inquiry` mode (or fallback)
  const waInquiry = buildWaFallback(
    "Minta Informasi & Penawaran",
    "Tim kami akan membalas pertanyaan Anda pada jam operasional.",
  );
  if (waInquiry) return waInquiry;
  const mailtoInquiry = buildSafeMailtoHref(
    options.tenantEmail,
    `Permintaan Informasi: ${offering.title}`,
  );
  if (mailtoInquiry) {
    return {
      mode: "inquiry",
      label: customLabel ?? "Kirim Pertanyaan via Email",
      href: mailtoInquiry,
      isExternal: false,
      isWhatsApp: false,
      helperNote: null,
    };
  }
  return {
    mode: "inquiry",
    label: customLabel ?? "Minta Informasi",
    href: options.isDetailPage ? "/#kontak" : detailPath,
    isExternal: false,
    isWhatsApp: false,
    helperNote: null,
  };
}

export function formatPublicIndonesianDate(
  isoOrMs: string | number | null | undefined,
  timezone = "Asia/Jakarta",
): string | null {
  if (isoOrMs === null || isoOrMs === undefined) return null;
  const date = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return null;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: timezone || "Asia/Jakarta",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Jakarta",
    }).format(date);
  }
}

export function formatDateOnlyIndonesian(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Extracts factual FAQ Q&A pairs from enabled visible FAQ sections on a page
 * so `generateSchemaGraph` emits semantic `FAQPage` JSON-LD (`REQ-022`).
 */
export function extractFaqItemsFromSections(sections: readonly unknown[]): readonly SchemaFaqItemInput[] {
  const items: SchemaFaqItemInput[] = [];
  for (const raw of sections) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const sec = raw as Record<string, unknown>;
    if (sec.enabled === false || sec.visible === false) continue;
    const type = typeof sec.type === "string" ? sec.type : typeof sec.kind === "string" ? sec.kind : "";
    if (type !== "faq") continue;
    const cfg =
      sec.config && typeof sec.config === "object" && !Array.isArray(sec.config)
        ? (sec.config as Record<string, unknown>)
        : sec;
    const rawItems = Array.isArray(cfg.items) ? cfg.items : [];
    for (const entry of rawItems) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const obj = entry as Record<string, unknown>;
      const q = typeof obj.question === "string" ? obj.question.trim() : "";
      const a = typeof obj.answer === "string" ? obj.answer.trim() : "";
      if (q && a) {
        items.push({ question: q, answer: a });
      }
    }
  }
  return items;
}

/**
 * Copies resolved HTTP status & cache/robots headers onto an Astro `Astro.response` object.
 */
export function applyPublicRouteResponseMeta(
  astroResponse: { status?: number; headers: Headers },
  http: PublicRouteHttpMeta,
): void {
  astroResponse.status = http.status;
  for (const [key, value] of Object.entries(http.headers)) {
    astroResponse.headers.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// Internal Host & Tenant Scope Resolution (Strict TASK-002 + TASK-051)
// ---------------------------------------------------------------------------

function buildSeoTenantInput(tenant: TenantContext): VerifiedTenantHostInput {
  const verifiedHosts = new Set<string>([tenant.host]);
  if (tenant.primaryHost) {
    verifiedHosts.add(tenant.primaryHost);
  }
  return {
    tenantHandle: tenant.handle,
    tenantStatus: tenant.status,
    operatorHold: tenant.operatorHold,
    primaryHost: tenant.primaryHost,
    primaryHostKind: tenant.primaryHostKind,
    primaryHostStatus: tenant.primaryHost ? "active" : null,
    primaryHostSslStatus: tenant.primaryHost ? "active" : null,
    primaryHostVerified: Boolean(tenant.primaryHost),
    verifiedTenantHosts: Array.from(verifiedHosts),
    servingHost: tenant.host,
  };
}

function classifyPlatformSurfaceFromHost(
  normalizedHost: string,
  platformDomain: string,
): "marketing" | "app" | "console" | null {
  const cleanPlatform = normalizeHost(platformDomain) ?? PLATFORM_HOSTS.marketing;
  if (normalizedHost === cleanPlatform || normalizedHost === `www.${cleanPlatform}`) {
    return "marketing";
  }
  if (normalizedHost === `app.${cleanPlatform}`) {
    return "app";
  }
  if (normalizedHost === `console.${cleanPlatform}`) {
    return "console";
  }
  const classified = classifySurfaceHost(normalizedHost);
  if (
    classified.surface === "marketing" ||
    classified.surface === "app" ||
    classified.surface === "console"
  ) {
    return classified.surface;
  }
  return null;
}

function resolveMediaBaseOrigin(mediaPublicBaseUrl?: string | null): string {
  if (mediaPublicBaseUrl) {
    const validated = validateTrustedMediaOrigin(mediaPublicBaseUrl);
    if (validated) return validated;
  }
  return DEFAULT_MEDIA_CDN_ORIGIN;
}

function createRedirectResponse(
  location: string,
  status: 301 | 308,
  options?: { readonly isTrial?: boolean },
): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "X-PunyaSitus-Surface": "tenant",
  });
  if (options?.isTrial) {
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return new Response(null, { status, headers });
}

function normalizeRequestUrl(request: Request, explicitUrl?: URL): URL | null {
  if (explicitUrl) return explicitUrl;
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

async function resolvePublicTenantScope(
  request: Request,
  deps: PublicRouteDeps,
  explicitUrl?: URL,
): Promise<TenantScopeResolution> {
  const url = normalizeRequestUrl(request, explicitUrl);
  if (!url) {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "unknown_host",
        response: createStatePageResponse("not_found", { pathname: "/", surface: "unknown" }),
      },
    };
  }

  const pathname = url.pathname;
  const normalizedUrlHost = normalizeHost(url.hostname);
  const platformDomain = deps.platformDomain ?? PLATFORM_HOSTS.marketing;

  // 1. Platform / unknown surface guard — tenant public routes NEVER serve on platform hosts
  if (
    deps.surface === "app" ||
    deps.surface === "console" ||
    deps.surface === "marketing"
  ) {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "platform_surface",
        response: createStatePageResponse("not_found", { pathname, surface: deps.surface }),
      },
    };
  }
  if (deps.surface === "unknown") {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "unknown_host",
        response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
      },
    };
  }

  if (normalizedUrlHost) {
    const platformSurface = classifyPlatformSurfaceFromHost(normalizedUrlHost, platformDomain);
    if (platformSurface) {
      return {
        kind: "response",
        result: {
          kind: "response",
          reason: "platform_surface",
          response: createStatePageResponse("not_found", {
            pathname,
            surface: platformSurface,
          }),
        },
      };
    }
  }

  // 2. Authoritative TenantContext from middleware locals OR live PLATFORM_DB lookup
  let tenant: TenantContext | null = deps.tenant ?? null;
  let tenantDb: D1Database | null = deps.tenantDb ?? null;

  if (!tenant) {
    if (!normalizedUrlHost || !deps.platformDb) {
      return {
        kind: "response",
        result: {
          kind: "response",
          reason: "unknown_host",
          response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
        },
      };
    }
    const resolution = await resolveTenantByHost(deps.platformDb, normalizedUrlHost, {
      nowMs: deps.nowMs,
      bypassCache: deps.bypassHostCache,
    });
    if (resolution.kind === "db_unavailable") {
      return {
        kind: "response",
        result: {
          kind: "response",
          reason: "unavailable",
          response: createStatePageResponse("unavailable", { pathname, surface: "unknown" }),
        },
      };
    }
    if (resolution.kind !== "resolved") {
      return {
        kind: "response",
        result: {
          kind: "response",
          reason: "unknown_host",
          response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
        },
      };
    }
    tenant = {
      id: resolution.tenant.id,
      organizationId: resolution.tenant.organizationId,
      handle: resolution.tenant.handle,
      name: resolution.tenant.name,
      vertical: resolution.tenant.vertical,
      status: resolution.tenant.effectiveStatus,
      storedStatus: resolution.tenant.storedStatus,
      operatorHold: resolution.tenant.operatorHold,
      cacheVersion: resolution.tenant.cacheVersion,
      schemaVersion: resolution.tenant.schemaVersion,
      host: resolution.hostRecord.host,
      hostKind: resolution.hostRecord.kind,
      isPrimary: resolution.hostRecord.isPrimary,
      primaryHost: resolution.primaryHost,
      primaryHostKind: resolution.primaryHostKind,
    };
  }

  // 3. Tenant lifecycle gates (PLAN §3.3 & §17.1)
  const effectiveStatus = tenant.operatorHold ? "suspended" : tenant.status;
  if (
    effectiveStatus === "provisioning" ||
    effectiveStatus === "purging" ||
    effectiveStatus === "purged"
  ) {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "destroyed",
        response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
      },
    };
  }
  if (effectiveStatus === "suspended") {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "suspended",
        response: createStatePageResponse("suspended", { pathname, surface: "tenant" }),
      },
    };
  }
  if (effectiveStatus === "recovery") {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "recovery",
        response: createStatePageResponse("recovery", { pathname, surface: "tenant" }),
      },
    };
  }

  // 4. Verified primary canonical origin (TASK-051)
  const seoTenant = buildSeoTenantInput(tenant);
  let verifiedOrigin: VerifiedCanonicalOrigin;
  try {
    verifiedOrigin = resolveVerifiedCanonicalOrigin(seoTenant);
  } catch {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "unknown_host",
        response: createStatePageResponse("not_found", { pathname, surface: "unknown" }),
      },
    };
  }

  // 5. Verified alias host -> single 301 redirect to primary canonical host
  if (verifiedOrigin.isAliasRequest) {
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      return {
        kind: "response",
        result: {
          kind: "response",
          reason: "alias_redirect",
          response: createRedirectResponse(
            `${verifiedOrigin.origin}${pathname}${url.search}`,
            301,
            { isTrial: effectiveStatus === "trial" },
          ),
        },
      };
    }
  }

  // 6. Bind tenant DO SQLite DB if not already provided
  if (!tenantDb && deps.tenantStore) {
    try {
      const stub = openTenantStoreStub(deps.tenantStore, tenant.id);
      tenantDb = createTenantDb(stub);
    } catch {
      return {
        kind: "response",
        result: {
          kind: "response",
          reason: "unavailable",
          response: createStatePageResponse("unavailable", { pathname, surface: "tenant" }),
        },
      };
    }
  }
  if (!tenantDb) {
    return {
      kind: "response",
      result: {
        kind: "response",
        reason: "unavailable",
        response: createStatePageResponse("unavailable", { pathname, surface: "tenant" }),
      },
    };
  }

  return {
    kind: "ok",
    scope: {
      tenant,
      tenantDb,
      seoTenant,
      verifiedOrigin,
      mediaBaseOrigin: resolveMediaBaseOrigin(deps.mediaPublicBaseUrl),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal Published Snapshot & Media Helpers (Zero Draft Leaks)
// ---------------------------------------------------------------------------

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function parseVariantsManifest(raw: string | null): MediaVariantsManifest | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MediaVariantsManifest>;
    return parsed && typeof parsed === "object" ? (parsed as MediaVariantsManifest) : null;
  } catch {
    return null;
  }
}

function mapVerifiedMediaRow(
  tenantId: string,
  row: RawMediaRow,
  mediaBaseOrigin: string,
): PublicResolvedImage | null {
  if (row.kind !== "image" || row.status !== "ready") return null;
  if (row.deleted_at !== undefined && row.deleted_at !== null) return null;

  const variants = parseVariantsManifest(row.variants_json);
  const preferred = variants?.w1280 ?? variants?.master ?? variants?.w640 ?? variants?.og ?? null;
  const candidateKey = preferred?.key ?? row.r2_key;
  if (!candidateKey || typeof candidateKey !== "string") return null;

  let verifiedKey: string;
  try {
    verifiedKey = assertTenantR2Key(tenantId, candidateKey, ["media"]);
  } catch {
    return null;
  }

  const normalizedPath = verifiedKey.replace(/^\/+/, "");
  const url = `${mediaBaseOrigin}/${normalizedPath}`;
  const alt = sanitizeSeoText(row.alt_text ?? "", { maxLength: 200 });
  const width = preferred?.width ?? row.width ?? 1200;
  const height = preferred?.height ?? row.height ?? 800;

  let ogCandidate: OgImageCandidate | null;
  try {
    ogCandidate = buildOgImageCandidateFromMediaRecord({
      tenantId,
      media: {
        id: Number(row.id),
        kind: "image",
        status: "ready",
        r2Key: row.r2_key,
        altText: alt,
        variants,
        deletedAt: row.deleted_at ?? null,
      },
      mediaPublicBaseUrl: mediaBaseOrigin,
      fallbackAlt: alt,
    });
  } catch {
    ogCandidate = null;
  }

  return {
    id: Number(row.id),
    url,
    alt,
    width: Math.max(1, Number(width) || 1200),
    height: Math.max(1, Number(height) || 800),
    mimeType: preferred?.mimeType ?? (row.mime_type || "image/webp"),
    bytes: preferred?.bytes ?? Number(row.bytes ?? 0),
    r2Key: verifiedKey,
    ogCandidate,
  };
}

async function loadVerifiedImagesById(
  tenantId: string,
  tenantDb: D1Database,
  mediaIds: ReadonlySet<number>,
  mediaBaseOrigin: string,
): Promise<Map<number, PublicResolvedImage>> {
  const result = new Map<number, PublicResolvedImage>();
  if (mediaIds.size === 0) return result;

  const ids = Array.from(mediaIds).filter(
    (id) => Number.isSafeInteger(id) && id >= 1 && id <= 2_147_483_647,
  );

  for (let i = 0; i < ids.length; i += SQL_IN_BATCH_SIZE) {
    const batch = ids.slice(i, i + SQL_IN_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const res = await tenantDb
      .prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`)
      .bind(...batch)
      .all<RawMediaRow>();
    for (const row of res.results) {
      const mapped = mapVerifiedMediaRow(tenantId, row, mediaBaseOrigin);
      if (mapped) {
        result.set(mapped.id, mapped);
      }
    }
  }
  return result;
}

async function loadAuthorsById(
  tenantDb: D1Database,
  authorIds: ReadonlySet<number>,
): Promise<Map<number, RawAuthorRow>> {
  const result = new Map<number, RawAuthorRow>();
  if (authorIds.size === 0) return result;
  const ids = Array.from(authorIds).filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(`SELECT id, name, bio FROM authors WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<RawAuthorRow>();
  for (const row of res.results) {
    result.set(Number(row.id), row);
  }
  return result;
}

async function loadTaxonomiesById(
  tenantDb: D1Database,
  taxonomyIds: ReadonlySet<number>,
): Promise<Map<number, RawTaxonomyRow>> {
  const result = new Map<number, RawTaxonomyRow>();
  if (taxonomyIds.size === 0) return result;
  const ids = Array.from(taxonomyIds).filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(`SELECT id, taxonomy_type, slug, name FROM taxonomies WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<RawTaxonomyRow>();
  for (const row of res.results) {
    result.set(Number(row.id), row);
  }
  return result;
}

function toSchemaImageInput(
  img: PublicResolvedImage | null | undefined,
  tenantId?: string,
): SchemaImageInput | null {
  if (!img) return null;
  return {
    url: img.url,
    width: img.width,
    height: img.height,
    alt: img.alt,
    tenantId: tenantId ?? null,
    status: "ready",
  };
}

function buildSchemaBusinessProfile(shell: TenantShellData): SchemaBusinessProfileInput {
  return {
    businessName: shell.business.name,
    businessCategory: shell.business.category,
    description: shell.business.description,
    phone: shell.business.phone,
    whatsappE164: shell.business.whatsappE164,
    publicEmail: shell.business.email,
    address: shell.business.address,
    city: shell.business.city,
    province: shell.business.province,
    postalCode: shell.business.postalCode,
    mapsUrl: shell.business.mapsUrl,
    weekdayHours: shell.business.weekdayHours,
    holidayHours: shell.business.holidayHours,
    socialLinks: shell.business.socialLinks,
  };
}

function toSchemaBreadcrumbs(
  breadcrumbs: readonly PublicBreadcrumbItem[],
): readonly SchemaBreadcrumbItemInput[] {
  return breadcrumbs.map((crumb) => ({
    label: crumb.label,
    path: crumb.href ?? undefined,
  }));
}

const ALLOWED_SEO_SCHEMA_TYPES = new Set<NonNullable<ResourceSeoOverrides["schemaType"]>>([
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
]);

interface NormalizedSeoOverridesPair {
  readonly seo: ResourceSeoOverrides | null;
  readonly canonicalOverride: string | null;
}

function mapPageSeoOverridesToSeoCore(
  seo: PageSeoOverrides | ResourceSeoOverrides | null | undefined,
): NormalizedSeoOverridesPair {
  if (!seo) return { seo: null, canonicalOverride: null };
  const bag = seo as Record<string, unknown>;
  const titleOverride =
    typeof bag.titleOverride === "string"
      ? bag.titleOverride
      : typeof bag.seoTitle === "string"
        ? bag.seoTitle
        : undefined;
  const descriptionOverride =
    typeof bag.descriptionOverride === "string"
      ? bag.descriptionOverride
      : typeof bag.seoDescription === "string"
        ? bag.seoDescription
        : undefined;
  const noindex = typeof bag.noindex === "boolean" ? bag.noindex : false;
  const nofollow = typeof bag.nofollow === "boolean" ? bag.nofollow : false;
  const canonicalOverride =
    typeof bag.canonicalOverride === "string" && bag.canonicalOverride.trim().length > 0
      ? bag.canonicalOverride.trim()
      : null;
  const ogTitleOverride =
    typeof bag.ogTitleOverride === "string" ? bag.ogTitleOverride : undefined;
  const ogDescriptionOverride =
    typeof bag.ogDescriptionOverride === "string" ? bag.ogDescriptionOverride : undefined;
  const ogImageMediaId =
    typeof bag.ogImageMediaId === "number" ? bag.ogImageMediaId : undefined;
  const rawSchemaType = typeof bag.schemaType === "string" ? bag.schemaType : undefined;
  const schemaType =
    rawSchemaType && ALLOWED_SEO_SCHEMA_TYPES.has(rawSchemaType as NonNullable<ResourceSeoOverrides["schemaType"]>)
      ? (rawSchemaType as NonNullable<ResourceSeoOverrides["schemaType"]>)
      : undefined;

  return {
    seo: {
      titleOverride,
      descriptionOverride,
      ogTitleOverride,
      ogDescriptionOverride,
      ogImageMediaId,
      noindex,
      nofollow,
      schemaType,
    },
    canonicalOverride,
  };
}

function buildPublicHeaders(params: {
  readonly status: 200 | 404;
  readonly tenant: TenantContext;
  readonly xRobotsTag?: string | null;
  readonly noStore?: boolean;
}): PublicRouteHttpMeta {
  const headers: Record<string, string> = {
    "X-PunyaSitus-Surface": "tenant",
    [CACHE_VERSION_HEADER_NAME]: String(params.tenant.cacheVersion),
    Vary: "Accept-Encoding",
  };

  if (params.status === 404 || params.noStore) {
    headers["Cache-Control"] = "no-store";
    headers["X-Robots-Tag"] = "noindex, nofollow";
  } else {
    headers["Cache-Control"] = `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}, s-maxage=${PUBLIC_CACHE_MAX_AGE_SECONDS}`;
    if (params.xRobotsTag) {
      headers["X-Robots-Tag"] = params.xRobotsTag;
    } else if (params.tenant.status === "trial") {
      headers["X-Robots-Tag"] = "noindex, nofollow";
    }
  }

  return { status: params.status, headers };
}

function buildFloatingWaModel(params: {
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly canonicalPath: string;
  readonly itemTitle: string;
  readonly itemPrice?: string;
}): PublicFloatingWaModel {
  const businessName = params.shell.business.name || params.shell.site.title;
  return {
    phone: params.shell.business.whatsappE164,
    businessName,
    operatingHours: params.shell.business.weekdayHours,
    holidayHours: params.shell.business.holidayHours,
    primaryOrigin: params.primaryOrigin,
    canonicalPath: params.canonicalPath,
    itemTitle: params.itemTitle,
    itemPrice: params.itemPrice,
    greetingMessage: `Halo! Ada yang bisa tim ${businessName} bantu terkait ${params.itemTitle}?`,
  };
}

function buildBrandedNotFoundResult(params: {
  readonly scope: ResolvedPublicTenantScope;
  readonly shell: TenantShellData;
  readonly currentPath: string;
  readonly heading?: string;
  readonly message?: string;
}): PublicBrandedNotFoundResult {
  const heading = params.heading ?? "Halaman Tidak Ditemukan";
  const message =
    params.message ??
    "Maaf, halaman atau konten yang Anda cari tidak tersedia, telah dipindahkan, atau sudah tidak diterbitkan.";

  const seoMetadata = generateOpenGraphMetadata({
    seo: {
      surface: "error",
      routeKind: "error_404",
      pathname: params.currentPath,
      tenant: null,
    },
    tenantId: params.scope.tenant.id,
    siteName: params.shell.site.title,
    resourceTitle: heading,
    resourceExcerpt: message,
    locale: params.shell.site.locale,
  });

  return {
    kind: "not_found",
    http: buildPublicHeaders({
      status: 404,
      tenant: params.scope.tenant,
      xRobotsTag: "noindex, nofollow",
      noStore: true,
    }),
    tenant: params.scope.tenant,
    shell: params.shell,
    primaryOrigin: params.scope.verifiedOrigin.origin,
    currentPath: params.currentPath,
    pageTitle: heading,
    heading,
    message,
    seoMetadata,
    floatingWa: buildFloatingWaModel({
      shell: params.shell,
      primaryOrigin: params.scope.verifiedOrigin.origin,
      canonicalPath: "/",
      itemTitle: params.shell.business.name || params.shell.site.title,
    }),
  };
}

function extractPublishedPageDto(row: RawPageRow): PublishedResourceDto<"page"> | null {
  try {
    return extractPublishedSnapshot("page", {
      resourceId: Number(row.id),
      status: row.status,
      deletedAt: row.deleted_at,
      publishedJson: row.published_sections_json,
      publishedAt: row.published_at,
      contentModifiedAt: row.content_modified_at,
      version: Number(row.version),
      updatedAt: Number(row.updated_at),
    });
  } catch {
    return null;
  }
}

function extractPublishedPostDto(row: RawPostRow): PublishedResourceDto<"post"> | null {
  try {
    return extractPublishedSnapshot("post", {
      resourceId: Number(row.id),
      status: row.status,
      deletedAt: row.deleted_at,
      publishedJson: row.published_body_json,
      publishedAt: row.published_at,
      contentModifiedAt: row.content_modified_at,
      version: Number(row.version),
      updatedAt: Number(row.updated_at),
    });
  } catch {
    return null;
  }
}

function extractPublishedOfferingDto(row: RawOfferingRow): PublishedResourceDto<"offering"> | null {
  try {
    return extractPublishedSnapshot("offering", {
      resourceId: Number(row.id),
      status: row.status,
      deletedAt: row.deleted_at,
      publishedJson: row.published_snapshot_json,
      publishedAt: row.published_at,
      contentModifiedAt: row.content_modified_at,
      version: Number(row.version),
      updatedAt: Number(row.updated_at),
    });
  } catch {
    return null;
  }
}

/**
 * Extracts validated vertical attributes STRICTLY from the frozen published snapshot
 * (`snap.verticalAttributes` + `snap.attributes`) — NEVER reading mutable draft columns
 * like `offerings.attributes_json`.
 */
function extractFrozenOfferingAttributes(
  offeringType: CatalogOfferingType,
  snapshot: OfferingSnapshot,
): Record<string, unknown> {
  let validatedFrozenVertical: Record<string, unknown> = {};
  if (
    snapshot.verticalAttributes &&
    typeof snapshot.verticalAttributes === "object" &&
    !Array.isArray(snapshot.verticalAttributes)
  ) {
    try {
      validatedFrozenVertical = validateOfferingAttributes(
        offeringType,
        snapshot.verticalAttributes,
      ) as Record<string, unknown>;
    } catch {
      validatedFrozenVertical = {};
    }
  }

  const merged: Record<string, unknown> = {
    ...validatedFrozenVertical,
    ...snapshot.attributes,
  };
  if (
    offeringType === "vehicle" &&
    merged.year === undefined &&
    typeof merged.vehicleYear === "number"
  ) {
    merged.year = merged.vehicleYear;
  }
  return merged;
}

function buildOfferingMetaLine(snapshot: OfferingSnapshot): string | null {
  const attrs = extractFrozenOfferingAttributes(snapshot.offeringType, snapshot);
  if (snapshot.offeringType === "tour") {
    const days = typeof attrs.durationDays === "number" ? attrs.durationDays : null;
    const nights = typeof attrs.durationNights === "number" ? attrs.durationNights : null;
    const destination = typeof attrs.destination === "string" ? attrs.destination : null;
    const parts: string[] = [];
    if (days !== null) {
      parts.push(nights !== null ? `${days} Hari ${nights} Malam` : `${days} Hari`);
    }
    if (destination) parts.push(destination);
    return parts.length > 0 ? parts.join(" • ") : null;
  }
  if (snapshot.offeringType === "vehicle") {
    const parts: string[] = [];
    if (typeof attrs.year === "number") parts.push(String(attrs.year));
    if (typeof attrs.transmission === "string") parts.push(attrs.transmission.toUpperCase());
    if (typeof attrs.fuelType === "string") parts.push(attrs.fuelType);
    if (typeof attrs.mileageKm === "number" && attrs.mileageKm > 0) {
      parts.push(`${String(attrs.mileageKm).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} km`);
    }
    return parts.length > 0 ? parts.join(" • ") : null;
  }
  if (snapshot.offeringType === "service") {
    const parts: string[] = [];
    if (typeof attrs.duration === "string") parts.push(attrs.duration);
    if (typeof attrs.serviceArea === "string") parts.push(attrs.serviceArea);
    return parts.length > 0 ? parts.join(" • ") : null;
  }
  if (snapshot.offeringType === "product") {
    const parts: string[] = [];
    if (typeof attrs.brand === "string") parts.push(attrs.brand);
    if (typeof attrs.unit === "string") parts.push(`Per ${attrs.unit}`);
    return parts.length > 0 ? parts.join(" • ") : null;
  }
  return null;
}

function renderOfferingDescriptionHtml(
  description: OfferingSnapshot["description"],
): string | null {
  if (!description) return null;
  if (typeof description === "string") {
    const trimmed = description.trim();
    if (!trimmed) return null;
    if (/<[a-z][\s\S]*>/i.test(trimmed)) {
      const sanitized = sanitizePublishedHtmlFragment(trimmed).trim();
      return sanitized || null;
    }
    const paragraphs = trimmed
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br />")}</p>`);
    return paragraphs.length > 0 ? paragraphs.join("\n") : null;
  }
  const html = renderRichTextDocToSanitizedHtml(description).trim();
  return html || null;
}

// ---------------------------------------------------------------------------
// 1. Page & Homepage Route Resolver (`/` and `/{pageSlug}`)
// ---------------------------------------------------------------------------

async function loadFallbackSectionsData(
  scope: ResolvedPublicTenantScope,
  shell: TenantShellData,
): Promise<{
  readonly fallbackOfferings: readonly SectionOfferingItem[];
  readonly fallbackPosts: BlogLatestSectionConfig["posts"];
}> {
  const [offeringRowsRes, postRowsRes] = await Promise.all([
    shell.site.catalogEnabled
      ? scope.tenantDb
          .prepare(
            `SELECT * FROM offerings
             WHERE status = 'published'
               AND deleted_at IS NULL
               AND published_snapshot_json IS NOT NULL
             ORDER BY COALESCE(published_at, created_at) DESC, id DESC
             LIMIT 12`,
          )
          .all<RawOfferingRow>()
      : Promise.resolve({ results: [] as RawOfferingRow[] }),
    shell.site.blogEnabled
      ? scope.tenantDb
          .prepare(
            `SELECT * FROM posts
             WHERE status = 'published'
               AND deleted_at IS NULL
               AND published_body_json IS NOT NULL
             ORDER BY COALESCE(published_at, created_at) DESC, id DESC
             LIMIT 6`,
          )
          .all<RawPostRow>()
      : Promise.resolve({ results: [] as RawPostRow[] }),
  ]);

  const offeringDtos: { readonly row: RawOfferingRow; readonly dto: PublishedResourceDto<"offering"> }[] = [];
  const postDtos: { readonly row: RawPostRow; readonly dto: PublishedResourceDto<"post"> }[] = [];
  const mediaIds = new Set<number>();
  const authorIds = new Set<number>();
  const categoryIds = new Set<number>();

  for (const row of offeringRowsRes.results) {
    const dto = extractPublishedOfferingDto(row);
    if (!dto) continue;
    offeringDtos.push({ row, dto });
    if (dto.data.coverMediaId) mediaIds.add(dto.data.coverMediaId);
  }
  for (const row of postRowsRes.results) {
    const dto = extractPublishedPostDto(row);
    if (!dto) continue;
    postDtos.push({ row, dto });
    if (dto.data.coverMediaId) mediaIds.add(dto.data.coverMediaId);
    if (dto.data.authorId) authorIds.add(dto.data.authorId);
    if (dto.data.primaryCategoryId) categoryIds.add(dto.data.primaryCategoryId);
  }

  const [imagesById, authorsById, taxonomiesById] = await Promise.all([
    loadVerifiedImagesById(scope.tenant.id, scope.tenantDb, mediaIds, scope.mediaBaseOrigin),
    loadAuthorsById(scope.tenantDb, authorIds),
    loadTaxonomiesById(scope.tenantDb, categoryIds),
  ]);

  const fallbackOfferings: SectionOfferingItem[] = offeringDtos.map(({ dto }) => {
    const cover = dto.data.coverMediaId ? imagesById.get(dto.data.coverMediaId) ?? null : null;
    return {
      offeringType: dto.data.offeringType,
      slug: dto.data.slug,
      title: dto.data.title,
      summary: dto.data.summary ?? undefined,
      priceMode: dto.data.priceMode,
      price: dto.data.price ?? undefined,
      priceMax: dto.data.priceMax ?? undefined,
      negotiable: dto.data.negotiable,
      originalAmount: dto.data.originalAmount ?? undefined,
      badge: dto.data.badge ?? undefined,
      unitStatus: dto.data.unitStatus ?? undefined,
      ctaKind: dto.data.ctaMode,
      ctaHref: dto.data.ctaMode === "external_link" ? dto.data.externalUrl ?? undefined : undefined,
      whatsappPhone: shell.business.whatsappE164 ?? undefined,
      metaLine: buildOfferingMetaLine(dto.data) ?? undefined,
      coverImage: cover
        ? {
            src: cover.url,
            alt: cover.alt || dto.data.title,
            width: cover.width,
            height: cover.height,
          }
        : undefined,
    };
  });

  const fallbackPosts: BlogLatestSectionConfig["posts"] = postDtos.map(({ row, dto }) => {
    const cover = dto.data.coverMediaId ? imagesById.get(dto.data.coverMediaId) ?? null : null;
    const authorName =
      dto.data.authorName ??
      (dto.data.authorId ? authorsById.get(dto.data.authorId)?.name ?? null : null);
    const categoryName = dto.data.primaryCategoryId
      ? taxonomiesById.get(dto.data.primaryCategoryId)?.name ?? null
      : null;
    return {
      slug: dto.data.slug,
      title: dto.data.title,
      excerpt: dto.data.excerpt ?? undefined,
      publishedAt: toIsoOrNull(row.published_at) ?? undefined,
      readingTimeMinutes: dto.data.readingTimeMinutes || 1,
      authorName: authorName ?? undefined,
      categoryName: categoryName ?? undefined,
      coverImage: cover
        ? {
            src: cover.url,
            alt: cover.alt || dto.data.title,
            width: cover.width,
            height: cover.height,
          }
        : undefined,
    };
  });

  return { fallbackOfferings, fallbackPosts };
}

/**
 * Resolves the homepage (`/`) or any static page (`/{pageSlug}`):
 * - Enforces tenant host/status gate (`404`/`503`/`301`)
 * - Returns `308` to `/` when `/{homePageSlug}` matches the currently-published homepage
 * - Returns single-hop `308` to current canonical URL when hitting a former slug of a
 *   currently-published page, and branded `404` when unpublished or trashed
 * - Returns branded `404` for drafts, trashed, multi-segment, or nonexistent page slugs
 */
export async function resolvePublicPageRoute(
  request: Request,
  deps: PublicRouteDeps,
  rawSlugParam?: string | null,
  options?: { readonly url?: URL },
): Promise<PublicPageRouteResult> {
  const scopeRes = await resolvePublicTenantScope(request, deps, options?.url);
  if (scopeRes.kind === "response") {
    return scopeRes.result;
  }
  const { scope } = scopeRes;
  const reqUrl = normalizeRequestUrl(request, options?.url);
  const rawTrimmed = (rawSlugParam ?? "").trim().replace(/^\/+|\/+$/g, "");
  const isHomepageRequest = rawTrimmed.length === 0;

  const shell = await loadPublishedTenantShellData(scope.tenantDb, {
    fallbackSiteTitle: scope.tenant.name,
    fallbackBusinessName: scope.tenant.name,
  });

  if (!isHomepageRequest) {
    const inspected = inspectSingleSlugParam(rawTrimmed);
    if (inspected.kind === "invalid") {
      return buildBrandedNotFoundResult({
        scope,
        shell,
        currentPath: reqUrl?.pathname ?? `/${rawTrimmed}`,
      });
    }
    const normalizedSlug =
      inspected.kind === "canonical" ? inspected.slug : inspected.canonicalSlug;
    const isMixedCase = inspected.kind === "mixed_case";
    const preservedQuery = buildPreservedRedirectQuery(reqUrl?.searchParams);

    // Check `resource_slugs` first for current OR former slug resolution (REQ-061)
    const slugRow = await findResourceSlug(scope.tenantDb, "pages", normalizedSlug);

    if (slugRow && !slugRow.isCurrent) {
      // Former slug -> check if target page is CURRENTLY published & non-trashed
      const targetRow = await scope.tenantDb
        .prepare(
          `SELECT * FROM pages
           WHERE id = ?
             AND status = 'published'
             AND deleted_at IS NULL
             AND published_sections_json IS NOT NULL
           LIMIT 1`,
        )
        .bind(slugRow.resourceId)
        .first<RawPageRow>();

      const targetDto = targetRow ? extractPublishedPageDto(targetRow) : null;
      if (targetDto) {
        const targetPath = targetDto.data.isHomepage ? "/" : `/${targetDto.data.slug}`;
        return {
          kind: "response",
          reason: "former_slug_redirect",
          response: createRedirectResponse(
            `${scope.verifiedOrigin.origin}${targetPath}${preservedQuery}`,
            308,
            { isTrial: scope.tenant.status === "trial" },
          ),
        };
      }
      // Target unpublished, trashed, or deleted -> MUST return 404 (NOT 308!)
      return buildBrandedNotFoundResult({
        scope,
        shell,
        currentPath: `/${normalizedSlug}`,
      });
    }

    // Load published page by current slug
    const pageRow = await scope.tenantDb
      .prepare(
        `SELECT * FROM pages
         WHERE slug = ?
           AND status = 'published'
           AND deleted_at IS NULL
           AND published_sections_json IS NOT NULL
         LIMIT 1`,
      )
      .bind(normalizedSlug)
      .first<RawPageRow>();

    const pageDto = pageRow ? extractPublishedPageDto(pageRow) : null;
    if (!pageRow || !pageDto) {
      return buildBrandedNotFoundResult({
        scope,
        shell,
        currentPath: `/${normalizedSlug}`,
      });
    }

    // Homepage slug canonicalization: `/{homeSlug}` -> ONE `308` to `/` (PLAN §7.1, §15.2)
    if (pageDto.data.isHomepage || Number(pageRow.is_homepage) === 1) {
      return {
        kind: "response",
        reason: "homepage_slug_redirect",
        response: createRedirectResponse(
          `${scope.verifiedOrigin.origin}/${preservedQuery}`,
          308,
          { isTrial: scope.tenant.status === "trial" },
        ),
      };
    }

    // Mixed-case slug canonicalization: ONE `308` to lowercase canonical URL (PLAN §15.2)
    if (isMixedCase) {
      return {
        kind: "response",
        reason: "mixed_case_slug_redirect",
        response: createRedirectResponse(
          `${scope.verifiedOrigin.origin}/${pageDto.data.slug}${preservedQuery}`,
          308,
          { isTrial: scope.tenant.status === "trial" },
        ),
      };
    }

    const currentPath = `/${pageDto.data.slug}`;
    const { seo: seoOverrides, canonicalOverride } = mapPageSeoOverridesToSeoCore(pageDto.data.seo);
    const ogMediaIds = new Set<number>();
    if (seoOverrides?.ogImageMediaId) ogMediaIds.add(seoOverrides.ogImageMediaId);
    const [imagesById, fallbacks] = await Promise.all([
      loadVerifiedImagesById(scope.tenant.id, scope.tenantDb, ogMediaIds, scope.mediaBaseOrigin),
      loadFallbackSectionsData(scope, shell),
    ]);

    const resourceImage = seoOverrides?.ogImageMediaId
      ? imagesById.get(seoOverrides.ogImageMediaId) ?? null
      : null;

    const seoInput: PublishedSeoDecisionInput = {
      surface: "public_tenant",
      routeKind: "page",
      pathname: currentPath,
      query: reqUrl?.searchParams,
      tenant: scope.seoTenant,
      siteVisibility: shell.site.siteVisibility,
      resourceState: "published",
      resourceSeo: seoOverrides,
      canonicalOverride,
    };

    const seoMetadata = generateOpenGraphMetadata({
      seo: seoInput,
      tenantId: scope.tenant.id,
      siteName: shell.site.title,
      siteTagline: shell.site.tagline,
      locale: shell.site.locale,
      resourceTitle: pageDto.data.title,
      resourceExcerpt: shell.business.description ?? shell.site.tagline,
      resourceOgImage: resourceImage?.ogCandidate ?? null,
      allowedMediaOrigins: [scope.mediaBaseOrigin],
    });

    const breadcrumbs: PublicBreadcrumbItem[] = [
      { label: "Beranda", href: "/" },
      { label: pageDto.data.title, href: null },
    ];
    const faqItems = extractFaqItemsFromSections(pageDto.data.sections);

    const schemaRes = generateSchemaGraph({
      seo: seoInput,
      tenantId: scope.tenant.id,
      siteName: shell.site.title,
      siteTagline: shell.site.tagline,
      locale: shell.site.locale,
      timezone: shell.site.timezone,
      business: buildSchemaBusinessProfile(shell),
      pageTitle: pageDto.data.title,
      pageDescription: seoMetadata.description,
      pageSchemaType: seoOverrides?.schemaType ?? null,
      pageDatePublished: toIsoOrNull(pageRow.published_at),
      pageDateModified: toIsoOrNull(pageRow.content_modified_at ?? pageRow.published_at),
      pageImage: toSchemaImageInput(resourceImage),
      breadcrumbs: toSchemaBreadcrumbs(breadcrumbs),
      faqItems,
      allowedMediaOrigins: [scope.mediaBaseOrigin],
    });

    const layoutMode: PageLayoutMode =
      pageDto.data.layoutMode === "focused" ? "focused" : "standard";

    return {
      kind: "page",
      http: buildPublicHeaders({
        status: 200,
        tenant: scope.tenant,
        xRobotsTag: seoMetadata.seoDecision.xRobotsTag,
      }),
      tenant: scope.tenant,
      shell: {
        ...shell,
        layoutMode,
        page: pageDto.data,
      },
      primaryOrigin: scope.verifiedOrigin.origin,
      currentPath,
      isHomepage: false,
      layoutMode,
      pageTitle: pageDto.data.title,
      page: pageDto.data,
      fallbackOfferings: fallbacks.fallbackOfferings,
      fallbackPosts: fallbacks.fallbackPosts,
      breadcrumbs,
      seoMetadata,
      schemaGraph: schemaRes.graph,
      floatingWa: buildFloatingWaModel({
        shell,
        primaryOrigin: scope.verifiedOrigin.origin,
        canonicalPath: currentPath,
        itemTitle: pageDto.data.title,
      }),
    };
  }

  // Homepage (`/`) resolution
  const homeRow = await scope.tenantDb
    .prepare(
      `SELECT * FROM pages
       WHERE is_homepage = 1
         AND status = 'published'
         AND deleted_at IS NULL
         AND published_sections_json IS NOT NULL
       LIMIT 1`,
    )
    .first<RawPageRow>();

  const homeDto = homeRow ? extractPublishedPageDto(homeRow) : null;
  const { seo: seoOverrides, canonicalOverride } = mapPageSeoOverridesToSeoCore(homeDto?.data.seo);
  const ogMediaIds = new Set<number>();
  if (seoOverrides?.ogImageMediaId) ogMediaIds.add(seoOverrides.ogImageMediaId);

  const [imagesById, fallbacks] = await Promise.all([
    loadVerifiedImagesById(scope.tenant.id, scope.tenantDb, ogMediaIds, scope.mediaBaseOrigin),
    loadFallbackSectionsData(scope, shell),
  ]);

  const resourceImage = seoOverrides?.ogImageMediaId
    ? imagesById.get(seoOverrides.ogImageMediaId) ?? null
    : null;

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind: "homepage",
    pathname: "/",
    query: reqUrl?.searchParams,
    tenant: scope.seoTenant,
    siteVisibility: shell.site.siteVisibility,
    resourceState: "published",
    resourceSeo: seoOverrides,
    canonicalOverride,
  };

  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    resourceTitle: homeDto?.data.title ?? shell.site.title,
    resourceExcerpt: shell.business.description ?? shell.site.tagline,
    resourceOgImage: resourceImage?.ogCandidate ?? null,
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const faqItems = homeDto ? extractFaqItemsFromSections(homeDto.data.sections) : [];

  const schemaRes = generateSchemaGraph({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    timezone: shell.site.timezone,
    business: buildSchemaBusinessProfile(shell),
    pageTitle: homeDto?.data.title ?? shell.site.title,
    pageDescription: seoMetadata.description,
    pageDatePublished: homeRow ? toIsoOrNull(homeRow.published_at) : null,
    pageDateModified: homeRow
      ? toIsoOrNull(homeRow.content_modified_at ?? homeRow.published_at)
      : null,
    pageImage: toSchemaImageInput(resourceImage),
    faqItems,
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const layoutMode: PageLayoutMode =
    homeDto?.data.layoutMode === "focused" ? "focused" : "standard";

  return {
    kind: "page",
    http: buildPublicHeaders({
      status: 200,
      tenant: scope.tenant,
      xRobotsTag: seoMetadata.seoDecision.xRobotsTag,
    }),
    tenant: scope.tenant,
    shell: {
      ...shell,
      layoutMode,
      page: homeDto?.data ?? null,
    },
    primaryOrigin: scope.verifiedOrigin.origin,
    currentPath: "/",
    isHomepage: true,
    layoutMode,
    pageTitle: homeDto?.data.title ?? shell.site.title,
    page: homeDto?.data ?? null,
    fallbackOfferings: fallbacks.fallbackOfferings,
    fallbackPosts: fallbacks.fallbackPosts,
    breadcrumbs: [],
    seoMetadata,
    schemaGraph: schemaRes.graph,
    floatingWa: buildFloatingWaModel({
      shell,
      primaryOrigin: scope.verifiedOrigin.origin,
      canonicalPath: "/",
      itemTitle: shell.business.name || shell.site.title,
    }),
  };
}

// ---------------------------------------------------------------------------
// 2. Blog Listing & Article Detail Resolvers (`/blog`, `/blog/[slug]`)
// ---------------------------------------------------------------------------

/**
 * Resolves `/blog` with pagination normalization (`?page=1` -> `301`, out-of-range -> `404`),
 * disabled-blog `404`, empty-state `200` (`noindex`), published-only snapshots, and SEO/Schema.
 */
export async function resolveBlogListingRoute(
  request: Request,
  deps: PublicRouteDeps,
  options?: { readonly url?: URL; readonly pageSize?: number },
): Promise<PublicBlogListingRouteResult> {
  const scopeRes = await resolvePublicTenantScope(request, deps, options?.url);
  if (scopeRes.kind === "response") {
    return scopeRes.result;
  }
  const { scope } = scopeRes;
  const reqUrl = normalizeRequestUrl(request, options?.url);

  const shell = await loadPublishedTenantShellData(scope.tenantDb, {
    fallbackSiteTitle: scope.tenant.name,
    fallbackBusinessName: scope.tenant.name,
  });

  if (!shell.site.blogEnabled) {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: "/blog",
      heading: "Blog Tidak Tersedia",
      message: "Bagian blog saat ini tidak diaktifkan pada situs ini.",
    });
  }

  // Load published post rows (published snapshot MUST be valid)
  const allRowsRes = await scope.tenantDb
    .prepare(
      `SELECT * FROM posts
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND published_body_json IS NOT NULL
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC`,
    )
    .all<RawPostRow>();

  const validPosts: { readonly row: RawPostRow; readonly dto: PublishedResourceDto<"post"> }[] = [];
  for (const row of allRowsRes.results) {
    const dto = extractPublishedPostDto(row);
    if (dto) {
      validPosts.push({ row, dto });
    }
  }

  const paginationDecision = parsePublicPaginationQuery({
    searchParams: reqUrl?.searchParams ?? new URLSearchParams(),
    basePath: "/blog",
    origin: scope.verifiedOrigin.origin,
    totalItems: validPosts.length,
    pageSize: options?.pageSize ?? DEFAULT_BLOG_PAGE_SIZE,
  });

  if (paginationDecision.kind === "redirect_page_one") {
    return {
      kind: "response",
      reason: "page_one_redirect",
      response: createRedirectResponse(paginationDecision.location, 301, {
        isTrial: scope.tenant.status === "trial",
      }),
    };
  }

  if (paginationDecision.kind === "not_found") {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: "/blog",
      heading: "Halaman Arsip Tidak Ditemukan",
      message: "Nomor halaman blog yang Anda minta tidak tersedia.",
    });
  }

  const { pagination } = paginationDecision;
  const pageSlice = validPosts.slice(pagination.offset, pagination.offset + pagination.pageSize);

  const mediaIds = new Set<number>();
  const authorIds = new Set<number>();
  const categoryIds = new Set<number>();
  for (const { dto } of pageSlice) {
    if (dto.data.coverMediaId) mediaIds.add(dto.data.coverMediaId);
    if (dto.data.authorId) authorIds.add(dto.data.authorId);
    if (dto.data.primaryCategoryId) categoryIds.add(dto.data.primaryCategoryId);
  }

  const [imagesById, authorsById, taxonomiesById] = await Promise.all([
    loadVerifiedImagesById(scope.tenant.id, scope.tenantDb, mediaIds, scope.mediaBaseOrigin),
    loadAuthorsById(scope.tenantDb, authorIds),
    loadTaxonomiesById(scope.tenantDb, categoryIds),
  ]);

  const items: PublicBlogListItem[] = pageSlice.map(({ row, dto }) => {
    const publishedIso = toIsoOrNull(row.published_at);
    const authorName =
      dto.data.authorName ??
      (dto.data.authorId ? authorsById.get(dto.data.authorId)?.name ?? null : null);
    const categoryName = dto.data.primaryCategoryId
      ? taxonomiesById.get(dto.data.primaryCategoryId)?.name ?? null
      : null;
    return {
      slug: dto.data.slug,
      href: `/blog/${dto.data.slug}`,
      title: dto.data.title,
      excerpt: dto.data.excerpt ?? null,
      authorName,
      categoryName,
      publishedAtIso: publishedIso,
      publishedDateLabel: formatPublicIndonesianDate(publishedIso, shell.site.timezone),
      readingTimeMinutes: dto.data.readingTimeMinutes || 1,
      coverImage: dto.data.coverMediaId ? imagesById.get(dto.data.coverMediaId) ?? null : null,
    };
  });

  const heading = "Blog & Artikel";
  const description = `Kumpulan artikel, panduan, dan informasi terbaru dari ${shell.business.name}.`;
  const pageTitle = pagination.page > 1 ? `${heading} — Halaman ${pagination.page}` : heading;
  const currentPath = pagination.page > 1 ? `/blog?page=${pagination.page}` : "/blog";

  const seoQuery = new URLSearchParams();
  if (pagination.page > 1) {
    seoQuery.set("page", String(pagination.page));
  }

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind: "blog_index",
    pathname: "/blog",
    query: seoQuery,
    tenant: scope.seoTenant,
    siteVisibility: shell.site.siteVisibility,
    resourceState: "published",
    archiveEnabled: true,
    publishedItemCount: pagination.totalItems,
    totalPages: pagination.totalPages,
  };

  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    resourceTitle: heading,
    resourceExcerpt: description,
    resourceOgImage: items[0]?.coverImage?.ogCandidate ?? null,
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const breadcrumbs: PublicBreadcrumbItem[] = [
    { label: "Beranda", href: "/" },
    { label: "Blog", href: pagination.page > 1 ? "/blog" : null },
    ...(pagination.page > 1
      ? [{ label: `Halaman ${pagination.page}`, href: null }]
      : []),
  ];

  const schemaRes = generateSchemaGraph({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    timezone: shell.site.timezone,
    business: buildSchemaBusinessProfile(shell),
    pageTitle,
    pageDescription: description,
    breadcrumbs: toSchemaBreadcrumbs(breadcrumbs),
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  return {
    kind: "blog_listing",
    http: buildPublicHeaders({
      status: 200,
      tenant: scope.tenant,
      xRobotsTag: seoMetadata.seoDecision.xRobotsTag,
    }),
    tenant: scope.tenant,
    shell,
    primaryOrigin: scope.verifiedOrigin.origin,
    currentPath,
    pageTitle,
    heading,
    description,
    items,
    pagination,
    breadcrumbs,
    seoMetadata,
    schemaGraph: schemaRes.graph,
    floatingWa: buildFloatingWaModel({
      shell,
      primaryOrigin: scope.verifiedOrigin.origin,
      canonicalPath: "/blog",
      itemTitle: `Artikel ${shell.business.name}`,
    }),
  };
}

/**
 * Resolves `/blog/[slug]`:
 * - `blogEnabled: false` -> `404`
 * - Former slug (`resource_slugs.namespace = 'blog'`, `is_current = 0`):
 *   - If target post is currently published -> ONE `308` to `/blog/${currentSlug}`
 *   - If target post is unpublished/trashed/missing -> branded `404`
 * - Current published post -> frozen published snapshot, sanitized HTML, TOC, reading time,
 *   author, breadcrumbs, `<SEOHead>` `og:type="article"`, `Article` JSON-LD
 */
export async function resolveBlogDetailRoute(
  request: Request,
  deps: PublicRouteDeps,
  rawSlug: string | undefined | null,
  options?: { readonly url?: URL },
): Promise<PublicBlogDetailRouteResult> {
  const scopeRes = await resolvePublicTenantScope(request, deps, options?.url);
  if (scopeRes.kind === "response") {
    return scopeRes.result;
  }
  const { scope } = scopeRes;
  const reqUrl = normalizeRequestUrl(request, options?.url);

  const shell = await loadPublishedTenantShellData(scope.tenantDb, {
    fallbackSiteTitle: scope.tenant.name,
    fallbackBusinessName: scope.tenant.name,
  });

  if (!shell.site.blogEnabled) {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? "/blog",
      heading: "Blog Tidak Tersedia",
      message: "Bagian blog saat ini tidak diaktifkan pada situs ini.",
    });
  }

  const inspected = inspectSingleSlugParam(rawSlug);
  if (inspected.kind === "invalid") {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? "/blog",
    });
  }
  const normalizedSlug =
    inspected.kind === "canonical" ? inspected.slug : inspected.canonicalSlug;
  const isMixedCase = inspected.kind === "mixed_case";
  const preservedQuery = buildPreservedRedirectQuery(reqUrl?.searchParams);

  // Former slug check (`REQ-061`)
  const slugRow = await findResourceSlug(scope.tenantDb, "blog", normalizedSlug);
  if (slugRow && !slugRow.isCurrent) {
    const targetRow = await scope.tenantDb
      .prepare(
        `SELECT * FROM posts
         WHERE id = ?
           AND status = 'published'
           AND deleted_at IS NULL
           AND published_body_json IS NOT NULL
         LIMIT 1`,
      )
      .bind(slugRow.resourceId)
      .first<RawPostRow>();

    const targetDto = targetRow ? extractPublishedPostDto(targetRow) : null;
    if (targetDto) {
      return {
        kind: "response",
        reason: "former_slug_redirect",
        response: createRedirectResponse(
          `${scope.verifiedOrigin.origin}/blog/${targetDto.data.slug}${preservedQuery}`,
          308,
          { isTrial: scope.tenant.status === "trial" },
        ),
      };
    }
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: `/blog/${normalizedSlug}`,
    });
  }

  const postRow = await scope.tenantDb
    .prepare(
      `SELECT * FROM posts
       WHERE slug = ?
         AND status = 'published'
         AND deleted_at IS NULL
         AND published_body_json IS NOT NULL
       LIMIT 1`,
    )
    .bind(normalizedSlug)
    .first<RawPostRow>();

  const postDto = postRow ? extractPublishedPostDto(postRow) : null;
  if (!postRow || !postDto) {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: `/blog/${normalizedSlug}`,
    });
  }

  if (isMixedCase) {
    return {
      kind: "response",
      reason: "mixed_case_slug_redirect",
      response: createRedirectResponse(
        `${scope.verifiedOrigin.origin}/blog/${postDto.data.slug}${preservedQuery}`,
        308,
        { isTrial: scope.tenant.status === "trial" },
      ),
    };
  }

  const snap = postDto.data;
  const { seo: seoOverrides, canonicalOverride } = mapPageSeoOverridesToSeoCore(snap.seo);
  const mediaIds = new Set<number>();
  if (snap.coverMediaId) mediaIds.add(snap.coverMediaId);
  if (seoOverrides?.ogImageMediaId) mediaIds.add(seoOverrides.ogImageMediaId);

  const taxonomyIds = new Set<number>();
  if (snap.primaryCategoryId) taxonomyIds.add(snap.primaryCategoryId);
  for (const cid of snap.categoryIds ?? []) taxonomyIds.add(cid);
  for (const tid of snap.tagIds ?? []) taxonomyIds.add(tid);

  const authorIds = new Set<number>();
  if (snap.authorId) authorIds.add(snap.authorId);

  // Load related published posts (excluding current post)
  const relatedRowsRes = await scope.tenantDb
    .prepare(
      `SELECT * FROM posts
       WHERE id != ?
         AND status = 'published'
         AND deleted_at IS NULL
         AND published_body_json IS NOT NULL
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC
       LIMIT 3`,
    )
    .bind(postRow.id)
    .all<RawPostRow>();

  const relatedValid: { readonly row: RawPostRow; readonly dto: PublishedResourceDto<"post"> }[] = [];
  for (const r of relatedRowsRes.results) {
    const rDto = extractPublishedPostDto(r);
    if (rDto) {
      relatedValid.push({ row: r, dto: rDto });
      if (rDto.data.coverMediaId) mediaIds.add(rDto.data.coverMediaId);
      if (rDto.data.authorId) authorIds.add(rDto.data.authorId);
      if (rDto.data.primaryCategoryId) taxonomyIds.add(rDto.data.primaryCategoryId);
    }
  }

  const [imagesById, authorsById, taxonomiesById] = await Promise.all([
    loadVerifiedImagesById(scope.tenant.id, scope.tenantDb, mediaIds, scope.mediaBaseOrigin),
    loadAuthorsById(scope.tenantDb, authorIds),
    loadTaxonomiesById(scope.tenantDb, taxonomyIds),
  ]);

  const coverImage = snap.coverMediaId ? imagesById.get(snap.coverMediaId) ?? null : null;
  const ogOverrideImage = seoOverrides?.ogImageMediaId
    ? imagesById.get(seoOverrides.ogImageMediaId) ?? null
    : null;
  const authorRow = snap.authorId ? authorsById.get(snap.authorId) ?? null : null;
  const authorName = snap.authorName ?? authorRow?.name ?? shell.business.name;
  const categoryName = snap.primaryCategoryId
    ? taxonomiesById.get(snap.primaryCategoryId)?.name ?? null
    : null;

  const categoryNames: string[] = [];
  const tagNames: string[] = [];
  const seenCats = new Set<string>();
  const seenTags = new Set<string>();
  for (const cid of [snap.primaryCategoryId, ...(snap.categoryIds ?? [])]) {
    if (!cid) continue;
    const tax = taxonomiesById.get(cid);
    if (tax && tax.taxonomy_type === "post_category" && !seenCats.has(tax.name)) {
      seenCats.add(tax.name);
      categoryNames.push(tax.name);
    }
  }
  for (const tid of snap.tagIds ?? []) {
    const tax = taxonomiesById.get(tid);
    if (tax && tax.taxonomy_type === "post_tag" && !seenTags.has(tax.name)) {
      seenTags.add(tax.name);
      tagNames.push(tax.name);
    }
  }

  // Always re-render & sanitize rich-text body from frozen published snapshot
  const sanitizedHtml =
    snap.sanitizedHtml && snap.sanitizedHtml.trim().length > 0
      ? sanitizePublishedHtmlFragment(snap.sanitizedHtml)
      : renderRichTextDocToSanitizedHtml(snap.body);
  const readingTimeMinutes = snap.readingTimeMinutes || calculateReadingTimeMinutes(sanitizedHtml);
  const toc = snap.showToc ? extractTocFromSanitizedHtml(sanitizedHtml) : [];

  const publishedAtIso = toIsoOrNull(postRow.published_at);
  const modifiedAtIso = toIsoOrNull(postRow.content_modified_at ?? postRow.published_at);
  const currentPath = `/blog/${snap.slug}`;

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind: "post",
    pathname: currentPath,
    query: reqUrl?.searchParams,
    tenant: scope.seoTenant,
    siteVisibility: shell.site.siteVisibility,
    resourceState: "published",
    resourceSeo: seoOverrides,
    canonicalOverride,
  };

  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    resourceTitle: snap.title,
    resourceExcerpt: snap.excerpt ?? undefined,
    ogType: "article",
    article: {
      publishedTime: publishedAtIso,
      modifiedTime: modifiedAtIso,
      author: authorName,
      section: categoryName,
      tags: tagNames,
    },
    resourceOgImage: ogOverrideImage?.ogCandidate ?? coverImage?.ogCandidate ?? null,
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const breadcrumbs: PublicBreadcrumbItem[] = [
    { label: "Beranda", href: "/" },
    { label: "Blog", href: "/blog" },
    { label: snap.title, href: null },
  ];

  const schemaRes = generateSchemaGraph({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    timezone: shell.site.timezone,
    business: buildSchemaBusinessProfile(shell),
    pageTitle: snap.title,
    pageDescription: seoMetadata.description,
    breadcrumbs: toSchemaBreadcrumbs(breadcrumbs),
    article: {
      schemaType: seoOverrides?.schemaType ?? "Article",
      headline: snap.title,
      description: snap.excerpt ?? seoMetadata.description,
      datePublished: publishedAtIso,
      dateModified: modifiedAtIso,
      authorName,
      image: toSchemaImageInput(ogOverrideImage ?? coverImage),
      section: categoryName,
      tags: tagNames,
      inLanguage: shell.site.locale,
    },
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const relatedPosts: PublicBlogListItem[] = relatedValid.map(({ row, dto }) => {
    const rPub = toIsoOrNull(row.published_at);
    return {
      slug: dto.data.slug,
      href: `/blog/${dto.data.slug}`,
      title: dto.data.title,
      excerpt: dto.data.excerpt ?? null,
      authorName:
        dto.data.authorName ??
        (dto.data.authorId ? authorsById.get(dto.data.authorId)?.name ?? null : null),
      categoryName: dto.data.primaryCategoryId
        ? taxonomiesById.get(dto.data.primaryCategoryId)?.name ?? null
        : null,
      publishedAtIso: rPub,
      publishedDateLabel: formatPublicIndonesianDate(rPub, shell.site.timezone),
      readingTimeMinutes: dto.data.readingTimeMinutes || 1,
      coverImage: dto.data.coverMediaId ? imagesById.get(dto.data.coverMediaId) ?? null : null,
    };
  });

  return {
    kind: "blog_detail",
    http: buildPublicHeaders({
      status: 200,
      tenant: scope.tenant,
      xRobotsTag: seoMetadata.seoDecision.xRobotsTag,
    }),
    tenant: scope.tenant,
    shell,
    primaryOrigin: scope.verifiedOrigin.origin,
    currentPath,
    pageTitle: snap.title,
    post: {
      slug: snap.slug,
      href: currentPath,
      title: snap.title,
      excerpt: snap.excerpt ?? null,
      sanitizedHtml,
      toc,
      showToc: Boolean(snap.showToc) && toc.length > 0,
      readingTimeMinutes,
      authorName,
      authorBio: authorRow?.bio ?? null,
      categoryName,
      categoryNames,
      tagNames,
      publishedAtIso,
      publishedDateLabel: formatPublicIndonesianDate(publishedAtIso, shell.site.timezone),
      modifiedAtIso,
      modifiedDateLabel: formatPublicIndonesianDate(modifiedAtIso, shell.site.timezone),
      coverImage,
    },
    relatedPosts,
    breadcrumbs,
    seoMetadata,
    schemaGraph: schemaRes.graph,
    floatingWa: buildFloatingWaModel({
      shell,
      primaryOrigin: scope.verifiedOrigin.origin,
      canonicalPath: currentPath,
      itemTitle: snap.title,
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. Typed Offering Listing & Detail Resolvers (`/layanan`, `/produk`, `/tour`, `/kendaraan`)
// ---------------------------------------------------------------------------

/**
 * Resolves published offering category names STRICTLY from the frozen `categoryIds`
 * stored inside `published_snapshot_json` — NEVER joining live draft `offering_taxonomies`.
 * Legacy snapshots without `categoryIds` cleanly receive `[]`.
 */
async function loadFrozenOfferingCategoryNamesBatch(
  tenantDb: D1Database,
  entries: readonly { readonly id: number; readonly categoryIds: readonly number[] | undefined }[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const allCategoryIds = new Set<number>();

  for (const entry of entries) {
    if (!entry.categoryIds || entry.categoryIds.length === 0) continue;
    for (const cid of entry.categoryIds) {
      if (Number.isSafeInteger(cid) && cid >= 1) {
        allCategoryIds.add(cid);
      }
    }
  }

  if (allCategoryIds.size === 0) return result;
  const taxonomiesById = await loadTaxonomiesById(tenantDb, allCategoryIds);

  for (const entry of entries) {
    if (!entry.categoryIds || entry.categoryIds.length === 0) continue;
    const names: string[] = [];
    for (const cid of entry.categoryIds) {
      const tax = taxonomiesById.get(cid);
      if (tax && tax.taxonomy_type === "offering_category" && !names.includes(tax.name)) {
        names.push(tax.name);
      }
    }
    if (names.length > 0) {
      result.set(entry.id, names);
    }
  }

  return result;
}

/**
 * Resolves typed offering listings (`/layanan`, `/produk`, `/tour`, `/kendaraan`)
 * with pagination (`?page=1` -> `301`, out-of-range -> `404`), disabled-catalog `404`,
 * empty-state `200` (`noindex`), published-only snapshots, honest IDR pricing, and zero-JS CTAs.
 */
export async function resolveOfferingListingRoute(
  request: Request,
  deps: PublicRouteDeps,
  offeringType: CatalogOfferingType,
  options?: { readonly url?: URL; readonly pageSize?: number },
): Promise<PublicOfferingListingRouteResult> {
  const descriptor = OFFERING_ROUTE_META[offeringType];
  const scopeRes = await resolvePublicTenantScope(request, deps, options?.url);
  if (scopeRes.kind === "response") {
    return scopeRes.result;
  }
  const { scope } = scopeRes;
  const reqUrl = normalizeRequestUrl(request, options?.url);

  const shell = await loadPublishedTenantShellData(scope.tenantDb, {
    fallbackSiteTitle: scope.tenant.name,
    fallbackBusinessName: scope.tenant.name,
  });

  if (!shell.site.catalogEnabled) {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: descriptor.prefix,
      heading: `${descriptor.pluralLabel} Tidak Tersedia`,
      message: "Katalog penawaran saat ini tidak diaktifkan pada situs ini.",
    });
  }

  const allRowsRes = await scope.tenantDb
    .prepare(
      `SELECT * FROM offerings
       WHERE offering_type = ?
         AND status = 'published'
         AND deleted_at IS NULL
         AND published_snapshot_json IS NOT NULL
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC`,
    )
    .bind(offeringType)
    .all<RawOfferingRow>();

  const validOfferings: { readonly row: RawOfferingRow; readonly dto: PublishedResourceDto<"offering"> }[] =
    [];
  for (const row of allRowsRes.results) {
    const dto = extractPublishedOfferingDto(row);
    if (dto && dto.data.offeringType === offeringType) {
      validOfferings.push({ row, dto });
    }
  }

  const paginationDecision = parsePublicPaginationQuery({
    searchParams: reqUrl?.searchParams ?? new URLSearchParams(),
    basePath: descriptor.prefix,
    origin: scope.verifiedOrigin.origin,
    totalItems: validOfferings.length,
    pageSize: options?.pageSize ?? DEFAULT_OFFERING_PAGE_SIZE,
  });

  if (paginationDecision.kind === "redirect_page_one") {
    return {
      kind: "response",
      reason: "page_one_redirect",
      response: createRedirectResponse(paginationDecision.location, 301, {
        isTrial: scope.tenant.status === "trial",
      }),
    };
  }

  if (paginationDecision.kind === "not_found") {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: descriptor.prefix,
      heading: "Halaman Katalog Tidak Ditemukan",
      message: `Nomor halaman ${descriptor.pluralLabel.toLowerCase()} yang Anda minta tidak tersedia.`,
    });
  }

  const { pagination } = paginationDecision;
  const pageSlice = validOfferings.slice(
    pagination.offset,
    pagination.offset + pagination.pageSize,
  );

  const mediaIds = new Set<number>();
  const frozenCategoryEntries: { readonly id: number; readonly categoryIds: readonly number[] | undefined }[] =
    [];
  for (const { row, dto } of pageSlice) {
    frozenCategoryEntries.push({ id: Number(row.id), categoryIds: dto.data.categoryIds });
    if (dto.data.coverMediaId) mediaIds.add(dto.data.coverMediaId);
  }

  const [imagesById, categoriesByOfferingId] = await Promise.all([
    loadVerifiedImagesById(scope.tenant.id, scope.tenantDb, mediaIds, scope.mediaBaseOrigin),
    loadFrozenOfferingCategoryNamesBatch(scope.tenantDb, frozenCategoryEntries),
  ]);

  const items: PublicOfferingListItem[] = pageSlice.map(({ row, dto }) => {
    const snap = dto.data;
    const categories = categoriesByOfferingId.get(Number(row.id)) ?? [];
    const priceText = formatPublicOfferingPrice(snap);
    const originalPriceText =
      snap.originalAmount !== undefined &&
      snap.originalAmount !== null &&
      snap.priceMode !== "on_request"
        ? formatIdrPlain(snap.originalAmount)
        : null;

    return {
      offeringType,
      slug: snap.slug,
      href: getOfferingPublicPath(offeringType, snap.slug),
      title: snap.title,
      summary: snap.summary ?? null,
      categoryName: categories[0] ?? null,
      badge: snap.badge ?? null,
      unitStatus: snap.unitStatus ?? null,
      unitStatusLabel: getVehicleUnitStatusLabel(snap.unitStatus),
      priceMode: snap.priceMode,
      priceText,
      originalPriceText,
      negotiable: snap.negotiable,
      metaLine: buildOfferingMetaLine(snap),
      coverImage: snap.coverMediaId ? imagesById.get(snap.coverMediaId) ?? null : null,
      cta: resolvePublicOfferingCta(snap, {
        primaryOrigin: scope.verifiedOrigin.origin,
        tenantWhatsappE164: shell.business.whatsappE164,
        tenantEmail: shell.business.email,
        tenantPhone: shell.business.phone,
        isDetailPage: false,
      }),
    };
  });

  const pageTitle =
    pagination.page > 1
      ? `${descriptor.listingHeading} — Halaman ${pagination.page}`
      : descriptor.listingHeading;
  const currentPath =
    pagination.page > 1 ? `${descriptor.prefix}?page=${pagination.page}` : descriptor.prefix;

  const seoQuery = new URLSearchParams();
  if (pagination.page > 1) {
    seoQuery.set("page", String(pagination.page));
  }

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind: "catalog_index",
    pathname: descriptor.prefix,
    query: seoQuery,
    tenant: scope.seoTenant,
    siteVisibility: shell.site.siteVisibility,
    resourceState: "published",
    archiveEnabled: true,
    publishedItemCount: pagination.totalItems,
    totalPages: pagination.totalPages,
  };

  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    resourceTitle: descriptor.listingHeading,
    resourceExcerpt: descriptor.listingDescription,
    resourceOgImage: items[0]?.coverImage?.ogCandidate ?? null,
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const breadcrumbs: PublicBreadcrumbItem[] = [
    { label: "Beranda", href: "/" },
    { label: descriptor.pluralLabel, href: pagination.page > 1 ? descriptor.prefix : null },
    ...(pagination.page > 1 ? [{ label: `Halaman ${pagination.page}`, href: null }] : []),
  ];

  const schemaRes = generateSchemaGraph({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    timezone: shell.site.timezone,
    business: buildSchemaBusinessProfile(shell),
    pageTitle,
    pageDescription: descriptor.listingDescription,
    breadcrumbs: toSchemaBreadcrumbs(breadcrumbs),
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  return {
    kind: "offering_listing",
    http: buildPublicHeaders({
      status: 200,
      tenant: scope.tenant,
      xRobotsTag: seoMetadata.seoDecision.xRobotsTag,
    }),
    tenant: scope.tenant,
    shell,
    primaryOrigin: scope.verifiedOrigin.origin,
    currentPath,
    descriptor,
    pageTitle,
    items,
    pagination,
    breadcrumbs,
    seoMetadata,
    schemaGraph: schemaRes.graph,
    floatingWa: buildFloatingWaModel({
      shell,
      primaryOrigin: scope.verifiedOrigin.origin,
      canonicalPath: descriptor.prefix,
      itemTitle: `${descriptor.pluralLabel} ${shell.business.name}`,
    }),
  };
}

/**
 * Resolves typed offering detail (`/layanan/[slug]`, `/produk/[slug]`, `/tour/[slug]`, `/kendaraan/[slug]`):
 * - Enforces tenant isolation & `catalogEnabled` gate
 * - Former slug (`is_current = 0`):
 *   - If target offering of matching type is currently published -> ONE `308` to `/{prefix}/{currentSlug}`
 *   - If target is unpublished, trashed, or missing -> branded `404`
 * - Renders frozen published snapshot with honest IDR pricing, verified gallery, typed attributes,
 *   static integer credit table (`vehicle`), zero-JS CTA, `<SEOHead>`, and factual JSON-LD.
 */
export async function resolveOfferingDetailRoute(
  request: Request,
  deps: PublicRouteDeps,
  offeringType: CatalogOfferingType,
  rawSlug: string | undefined | null,
  options?: { readonly url?: URL },
): Promise<PublicOfferingDetailRouteResult> {
  const descriptor = OFFERING_ROUTE_META[offeringType];
  const namespace = getOfferingSlugNamespace(offeringType);
  const scopeRes = await resolvePublicTenantScope(request, deps, options?.url);
  if (scopeRes.kind === "response") {
    return scopeRes.result;
  }
  const { scope } = scopeRes;
  const reqUrl = normalizeRequestUrl(request, options?.url);

  const shell = await loadPublishedTenantShellData(scope.tenantDb, {
    fallbackSiteTitle: scope.tenant.name,
    fallbackBusinessName: scope.tenant.name,
  });

  if (!shell.site.catalogEnabled) {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? descriptor.prefix,
      heading: `${descriptor.pluralLabel} Tidak Tersedia`,
      message: "Katalog penawaran saat ini tidak diaktifkan pada situs ini.",
    });
  }

  const inspected = inspectSingleSlugParam(rawSlug);
  if (inspected.kind === "invalid") {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? descriptor.prefix,
    });
  }
  const normalizedSlug =
    inspected.kind === "canonical" ? inspected.slug : inspected.canonicalSlug;
  const isMixedCase = inspected.kind === "mixed_case";
  const preservedQuery = buildPreservedRedirectQuery(reqUrl?.searchParams);

  // Former slug single-hop 308 check (`REQ-061`)
  const slugRow = await findResourceSlug(scope.tenantDb, namespace, normalizedSlug);
  if (slugRow && !slugRow.isCurrent) {
    const targetRow = await scope.tenantDb
      .prepare(
        `SELECT * FROM offerings
         WHERE id = ?
           AND offering_type = ?
           AND status = 'published'
           AND deleted_at IS NULL
           AND published_snapshot_json IS NOT NULL
         LIMIT 1`,
      )
      .bind(slugRow.resourceId, offeringType)
      .first<RawOfferingRow>();

    const targetDto = targetRow ? extractPublishedOfferingDto(targetRow) : null;
    if (targetDto && targetDto.data.offeringType === offeringType) {
      const targetPath = getOfferingPublicPath(offeringType, targetDto.data.slug);
      return {
        kind: "response",
        reason: "former_slug_redirect",
        response: createRedirectResponse(
          `${scope.verifiedOrigin.origin}${targetPath}${preservedQuery}`,
          308,
          { isTrial: scope.tenant.status === "trial" },
        ),
      };
    }
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: `${descriptor.prefix}/${normalizedSlug}`,
    });
  }

  const offeringRow = await scope.tenantDb
    .prepare(
      `SELECT * FROM offerings
       WHERE offering_type = ?
         AND slug = ?
         AND status = 'published'
         AND deleted_at IS NULL
         AND published_snapshot_json IS NOT NULL
       LIMIT 1`,
    )
    .bind(offeringType, normalizedSlug)
    .first<RawOfferingRow>();

  const offeringDto = offeringRow ? extractPublishedOfferingDto(offeringRow) : null;
  if (!offeringRow || !offeringDto || offeringDto.data.offeringType !== offeringType) {
    return buildBrandedNotFoundResult({
      scope,
      shell,
      currentPath: `${descriptor.prefix}/${normalizedSlug}`,
    });
  }

  if (isMixedCase) {
    const canonicalPath = getOfferingPublicPath(offeringType, offeringDto.data.slug);
    return {
      kind: "response",
      reason: "mixed_case_slug_redirect",
      response: createRedirectResponse(
        `${scope.verifiedOrigin.origin}${canonicalPath}${preservedQuery}`,
        308,
        { isTrial: scope.tenant.status === "trial" },
      ),
    };
  }

  const snap = offeringDto.data;
  const { seo: seoOverrides, canonicalOverride } = mapPageSeoOverridesToSeoCore(snap.seo);

  const mediaIds = new Set<number>();
  if (snap.coverMediaId) mediaIds.add(snap.coverMediaId);
  if (seoOverrides?.ogImageMediaId) mediaIds.add(seoOverrides.ogImageMediaId);
  for (const gid of snap.galleryMediaIds ?? []) {
    mediaIds.add(gid);
  }

  // Load up to 3 related published offerings of the same type
  const relatedRowsRes = await scope.tenantDb
    .prepare(
      `SELECT * FROM offerings
       WHERE offering_type = ?
         AND id != ?
         AND status = 'published'
         AND deleted_at IS NULL
         AND published_snapshot_json IS NOT NULL
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC
       LIMIT 3`,
    )
    .bind(offeringType, offeringRow.id)
    .all<RawOfferingRow>();

  const relatedValid: { readonly row: RawOfferingRow; readonly dto: PublishedResourceDto<"offering"> }[] =
    [];
  const frozenCategoryEntries: { readonly id: number; readonly categoryIds: readonly number[] | undefined }[] =
    [{ id: Number(offeringRow.id), categoryIds: snap.categoryIds }];
  for (const r of relatedRowsRes.results) {
    const rDto = extractPublishedOfferingDto(r);
    if (rDto && rDto.data.offeringType === offeringType) {
      relatedValid.push({ row: r, dto: rDto });
      frozenCategoryEntries.push({ id: Number(r.id), categoryIds: rDto.data.categoryIds });
      if (rDto.data.coverMediaId) mediaIds.add(rDto.data.coverMediaId);
    }
  }

  const [imagesById, categoriesByOfferingId] = await Promise.all([
    loadVerifiedImagesById(scope.tenant.id, scope.tenantDb, mediaIds, scope.mediaBaseOrigin),
    loadFrozenOfferingCategoryNamesBatch(scope.tenantDb, frozenCategoryEntries),
  ]);

  const coverImage = snap.coverMediaId ? imagesById.get(snap.coverMediaId) ?? null : null;
  const ogOverrideImage = seoOverrides?.ogImageMediaId
    ? imagesById.get(seoOverrides.ogImageMediaId) ?? null
    : null;

  const galleryImages: PublicResolvedImage[] = [];
  const seenImgIds = new Set<number>();
  if (coverImage) seenImgIds.add(coverImage.id);
  for (const gid of snap.galleryMediaIds ?? []) {
    if (seenImgIds.has(gid)) continue;
    const img = imagesById.get(gid);
    if (img) {
      seenImgIds.add(gid);
      galleryImages.push(img);
    }
  }

  const categoryNames = categoriesByOfferingId.get(Number(offeringRow.id)) ?? [];
  const currentPath = getOfferingPublicPath(offeringType, snap.slug);
  const priceText = formatPublicOfferingPrice(snap);
  const originalPriceText =
    snap.originalAmount !== undefined &&
    snap.originalAmount !== null &&
    snap.priceMode !== "on_request"
      ? formatIdrPlain(snap.originalAmount)
      : null;

  const cta = resolvePublicOfferingCta(snap, {
    primaryOrigin: scope.verifiedOrigin.origin,
    tenantWhatsappE164: shell.business.whatsappE164,
    tenantEmail: shell.business.email,
    tenantPhone: shell.business.phone,
    isDetailPage: true,
  });

  const fallbackContactHref = shell.business.phone
    ? `tel:${shell.business.phone.replace(/[^\d+]/g, "")}`
    : buildSafeMailtoHref(shell.business.email);

  // Strictly read vertical attributes from frozen published snapshot ONLY (NEVER live `offeringRow.attributes_json`!)
  const mergedAttrs = extractFrozenOfferingAttributes(offeringType, snap);

  const serviceAttributes =
    offeringType === "service" ? (mergedAttrs as ServiceAttributes) : null;
  const productAttributes =
    offeringType === "product" ? (mergedAttrs as ProductAttributes) : null;
  const tourAttributes = offeringType === "tour" ? (mergedAttrs as TourAttributes) : null;
  const vehicleAttributes =
    offeringType === "vehicle" ? (mergedAttrs as VehicleAttributes) : null;

  // Static server-rendered credit table: ONLY for available + fixed price vehicles with frozen config (DESIGN.md §7)
  const effectiveUnitStatus = snap.unitStatus ?? vehicleAttributes?.unitStatus ?? null;
  const vehicleCreditRows =
    offeringType === "vehicle" &&
    effectiveUnitStatus === "available" &&
    snap.priceMode === "fixed" &&
    typeof snap.price === "number" &&
    snap.price > 0 &&
    vehicleAttributes?.creditEstimateEnabled === true &&
    vehicleAttributes.creditEstimateConfig
      ? computeVehicleCreditEstimateRows(snap.price, vehicleAttributes.creditEstimateConfig)
      : [];

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind: "offering",
    pathname: currentPath,
    query: reqUrl?.searchParams,
    tenant: scope.seoTenant,
    siteVisibility: shell.site.siteVisibility,
    resourceState: "published",
    resourceSeo: seoOverrides,
    canonicalOverride,
  };

  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    resourceTitle: snap.title,
    resourceExcerpt: snap.summary ?? `${snap.title} — ${priceText}`,
    offeringType,
    resourceOgImage: ogOverrideImage?.ogCandidate ?? coverImage?.ogCandidate ?? null,
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const breadcrumbs: PublicBreadcrumbItem[] = [
    { label: "Beranda", href: "/" },
    { label: descriptor.pluralLabel, href: descriptor.prefix },
    { label: snap.title, href: null },
  ];

  const schemaImages = [coverImage, ...galleryImages]
    .map((img) => toSchemaImageInput(img))
    .filter((img): img is SchemaImageInput => Boolean(img));

  const schemaRes = generateSchemaGraph({
    seo: seoInput,
    tenantId: scope.tenant.id,
    siteName: shell.site.title,
    siteTagline: shell.site.tagline,
    locale: shell.site.locale,
    timezone: shell.site.timezone,
    business: buildSchemaBusinessProfile(shell),
    pageTitle: snap.title,
    pageDescription: seoMetadata.description,
    breadcrumbs: toSchemaBreadcrumbs(breadcrumbs),
    offering: {
      offeringType,
      title: snap.title,
      summary: snap.summary ?? null,
      priceMode: snap.priceMode,
      price: snap.price ?? null,
      priceMax: snap.priceMax ?? null,
      negotiable: snap.negotiable,
      ctaMode: snap.ctaMode,
      unitStatus: effectiveUnitStatus,
      categoryName: categoryNames[0] ?? null,
      images: schemaImages,
      attributes: mergedAttrs,
    },
    now: deps.nowMs,
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  const relatedOfferings: PublicOfferingListItem[] = relatedValid.map(({ row, dto }) => {
    const rSnap = dto.data;
    const rCats = categoriesByOfferingId.get(Number(row.id)) ?? [];
    return {
      offeringType,
      slug: rSnap.slug,
      href: getOfferingPublicPath(offeringType, rSnap.slug),
      title: rSnap.title,
      summary: rSnap.summary ?? null,
      categoryName: rCats[0] ?? null,
      badge: rSnap.badge ?? null,
      unitStatus: rSnap.unitStatus ?? null,
      unitStatusLabel: getVehicleUnitStatusLabel(rSnap.unitStatus),
      priceMode: rSnap.priceMode,
      priceText: formatPublicOfferingPrice(rSnap),
      originalPriceText:
        rSnap.originalAmount !== undefined &&
        rSnap.originalAmount !== null &&
        rSnap.priceMode !== "on_request"
          ? formatIdrPlain(rSnap.originalAmount)
          : null,
      negotiable: rSnap.negotiable,
      metaLine: buildOfferingMetaLine(rSnap),
      coverImage: rSnap.coverMediaId ? imagesById.get(rSnap.coverMediaId) ?? null : null,
      cta: resolvePublicOfferingCta(rSnap, {
        primaryOrigin: scope.verifiedOrigin.origin,
        tenantWhatsappE164: shell.business.whatsappE164,
        tenantEmail: shell.business.email,
        tenantPhone: shell.business.phone,
        isDetailPage: false,
      }),
    };
  });

  return {
    kind: "offering_detail",
    http: buildPublicHeaders({
      status: 200,
      tenant: scope.tenant,
      xRobotsTag: seoMetadata.seoDecision.xRobotsTag,
    }),
    tenant: scope.tenant,
    shell,
    primaryOrigin: scope.verifiedOrigin.origin,
    currentPath,
    descriptor,
    pageTitle: snap.title,
    offering: {
      offeringType,
      slug: snap.slug,
      href: currentPath,
      title: snap.title,
      summary: snap.summary ?? null,
      descriptionHtml: renderOfferingDescriptionHtml(snap.description),
      categoryNames,
      badge: snap.badge ?? null,
      unitStatus: effectiveUnitStatus,
      unitStatusLabel: getVehicleUnitStatusLabel(effectiveUnitStatus),
      priceMode: snap.priceMode,
      priceText,
      originalPriceText,
      negotiable: snap.negotiable,
      coverImage,
      galleryImages,
      cta,
      fallbackContactHref,
      attributes: snap.attributes,
      serviceAttributes,
      productAttributes,
      tourAttributes,
      vehicleAttributes,
      vehicleCreditRows,
      publishedDateLabel: formatPublicIndonesianDate(
        toIsoOrNull(offeringRow.published_at),
        shell.site.timezone,
      ),
      modifiedDateLabel: formatPublicIndonesianDate(
        toIsoOrNull(offeringRow.content_modified_at ?? offeringRow.published_at),
        shell.site.timezone,
      ),
    },
    relatedOfferings,
    breadcrumbs,
    seoMetadata,
    schemaGraph: schemaRes.graph,
    floatingWa: buildFloatingWaModel({
      shell,
      primaryOrigin: scope.verifiedOrigin.origin,
      canonicalPath: currentPath,
      itemTitle: snap.title,
      itemPrice: priceText,
    }),
  };
}

/**
 * Helper for Astro pages to safely extract `PublicRouteDeps` from `Astro.locals` + runtime `env`
 * without pulling `cloudflare:workers` into `public-routes.ts`.
 */
export function buildPublicRouteDepsFromAstro(
  locals: unknown,
  runtimeEnv: {
    readonly PLATFORM_DB?: D1Database | null;
    readonly TENANT_STORE?: unknown;
    readonly PLATFORM_DOMAIN?: string;
    readonly SAAS_ZONE?: string;
    readonly MEDIA_PUBLIC_BASE_URL?: string;
  },
): PublicRouteDeps {
  const bag = (locals ?? {}) as Partial<{
    readonly surface: SurfaceKind;
    readonly host: string;
    readonly tenant: TenantContext | null;
    readonly tenantDb: D1Database | null;
  }>;
  const mediaUrl =
    typeof runtimeEnv.MEDIA_PUBLIC_BASE_URL === "string" &&
    runtimeEnv.MEDIA_PUBLIC_BASE_URL.trim().length > 0
      ? runtimeEnv.MEDIA_PUBLIC_BASE_URL.trim()
      : null;

  return {
    surface: bag.surface,
    host: bag.host,
    tenant: bag.tenant ?? null,
    tenantDb: bag.tenantDb ?? null,
    platformDb: runtimeEnv.PLATFORM_DB ?? null,
    tenantStore: (runtimeEnv.TENANT_STORE as TenantStoreNamespaceLike | undefined) ?? null,
    platformDomain: runtimeEnv.PLATFORM_DOMAIN,
    saasZone: runtimeEnv.SAAS_ZONE,
    mediaPublicBaseUrl: mediaUrl,
  };
}

// Re-export helpers commonly needed by Astro templates
export {
  getOfferingPublicBasePath,
  getOfferingPublicPath,
  normalizeIndonesianWhatsAppNumber,
  sanitizeNavigationHref,
};
