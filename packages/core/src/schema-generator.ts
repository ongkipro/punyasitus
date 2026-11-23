import { PLATFORM_HOSTS } from "./index.ts";
import type {
  CatalogCtaMode,
  CatalogOfferingType,
  CatalogPriceMode,
  CatalogVehicleUnitStatus,
  ProductAttributes,
  ServiceAttributes,
  TourAttributes,
  VehicleAttributes,
} from "./catalog/index.ts";
import type {
  BusinessProfileSnapshot,
  OfferingSnapshot,
  PageSnapshot,
  PostSnapshot,
  SiteSettingsSnapshot,
} from "./content/index.ts";
import {
  normalizePublicPath,
  resolvePublishedResourcePathname,
  resolvePublishedResourceSeoDecision,
  resolvePublishedSeoDecision,
  resolveVerifiedCanonicalOrigin,
  safeJsonLdStringify,
  sanitizeSeoText,
  validateCanonicalHostname,
  validateCanonicalOrigin,
  validateCanonicalOverride,
  type PublishedContentDto,
  type PublishedResourceSeoInput,
  type PublishedSeoDecision,
  type PublishedSeoDecisionInput,
  type SeoRouteKind,
} from "./seo/index.ts";

/**
 * Schema.org Structured Data (`@graph` JSON-LD) Generator
 * (REQ-022, REQ-026, REQ-079, REQ-088, REQ-091, REQ-092, REQ-095, PLAN §15.4 & §15.7, TASK-015).
 *
 * Shared Schema.org JSON-LD engine for PunyaSitus. Reuses TASK-051
 * (`@punyasitus/core/seo/index`) for authoritative canonical origin resolution,
 * publication/lifecycle gates, and safe script-context escaping.
 *
 * Hard Invariants:
 * - Consumes ONLY verified canonical origins (via TASK-051) and visible published facts.
 * - NEVER emits JSON-LD for draft, unpublished, trashed, preview, private, admin, auth,
 *   API, error (404/500/503), suspended, recovery, purged/destroyed, unknown-host,
 *   redirect, or canonical-less routes (`emitted: false`, `graph: null`, `jsonLd: null`).
 * - NEVER trusts raw `Host` or `X-Forwarded-Host` headers.
 * - NEVER invents fake ratings (`AggregateRating`), fake reviews, fake stock/availability,
 *   fake addresses, financing/credit structured data, or fake `Product` `Offer` prices.
 * - `service` and `inquiry` / `on_request` items NEVER invent a `Product` or numeric `Offer.price`.
 * - `tour` (`TouristTrip`) omits past departure dates when `now` is provided.
 * - Deprecated `ProfessionalService` is NEVER emitted; falls back to `LocalBusiness`.
 * - Explicitly records that valid Schema.org JSON-LD describes visible facts for semantic
 *   clarity only and does NOT guarantee search engine rich-result eligibility or rankings.
 */

export const SCHEMA_ORG_CONTEXT = "https://schema.org" as const;

export const SCHEMA_RICH_RESULT_DISCLAIMER =
  "Valid Schema.org JSON-LD describes visible published page facts for semantic clarity only; it does not guarantee search engine rich-result eligibility, rankings, or AI citation." as const;

export const FAQ_RICH_RESULT_NOTE =
  "FAQPage is emitted from visible Q&A content for semantic clarity only; Google discontinued FAQ rich results on 2026-05-07." as const;

export const SCHEMA_DEFAULT_MEDIA_CDN_ORIGIN = `https://media.${PLATFORM_HOSTS.marketing}` as const;
export const SCHEMA_DEFAULT_LANGUAGE = "id-ID" as const;
export const SCHEMA_DEFAULT_TIMEZONE = "Asia/Jakarta" as const;
export const SCHEMA_CURRENCY_IDR = "IDR" as const;

export const SCHEMA_ENTITY_FRAGMENTS = {
  website: "#website",
  organization: "#organization",
  webpage: "#webpage",
  breadcrumb: "#breadcrumb",
  article: "#article",
  faq: "#faq",
  product: "#product",
  service: "#service",
  touristTrip: "#tourist-trip",
  vehicle: "#vehicle",
} as const;

/**
 * Closed allowlist of current Schema.org Organization / LocalBusiness subtypes (REQ-091, PLAN §15.4).
 * Deprecated `ProfessionalService` is intentionally excluded and rejected.
 */
export const ALLOWED_BUSINESS_SCHEMA_TYPES = [
  "Organization",
  "LocalBusiness",
  "TravelAgency",
  "AutoDealer",
  "MotorcycleDealer",
  "AutomotiveBusiness",
  "AutoRepair",
  "Restaurant",
  "CafeOrCoffeeShop",
  "Bakery",
  "FoodEstablishment",
  "Store",
  "MedicalClinic",
  "Dentist",
  "LegalService",
  "AccountingService",
  "RealEstateAgent",
  "HomeAndConstructionBusiness",
  "HealthAndBeautyBusiness",
  "BeautySalon",
  "EducationalOrganization",
  "FinancialService",
  "LodgingBusiness",
  "Hotel",
  "SportsActivityLocation",
] as const;

export type AllowedBusinessSchemaType = (typeof ALLOWED_BUSINESS_SCHEMA_TYPES)[number];

export const ALLOWED_PAGE_SCHEMA_TYPES = [
  "WebPage",
  "AboutPage",
  "ContactPage",
  "CollectionPage",
  "ProfilePage",
] as const;

export type AllowedPageSchemaType = (typeof ALLOWED_PAGE_SCHEMA_TYPES)[number];

export const ALLOWED_ARTICLE_SCHEMA_TYPES = [
  "BlogPosting",
  "Article",
  "NewsArticle",
] as const;

export type AllowedArticleSchemaType = (typeof ALLOWED_ARTICLE_SCHEMA_TYPES)[number];

export type SchemaSuppressionReason =
  | "non_public_route"
  | "non_serving_tenant"
  | "unpublished_resource"
  | "redirect_route"
  | "missing_canonical";

export type SchemaNode = Readonly<Record<string, unknown>> & {
  readonly "@type": string;
  readonly "@id"?: string;
};

export interface SchemaGraphDocument {
  readonly "@context": typeof SCHEMA_ORG_CONTEXT;
  readonly "@graph": readonly SchemaNode[];
}

export interface SchemaPolicyMetadata {
  /** Always `false`: valid JSON-LD never claims guaranteed rich-result eligibility (TASK-015, PLAN §15.4). */
  readonly guaranteesRichResultEligibility: false;
  /** Always `false`: structured data never guarantees search ranking or AI citation. */
  readonly guaranteesSearchRanking: false;
  readonly disclaimer: typeof SCHEMA_RICH_RESULT_DISCLAIMER;
  readonly notes: readonly string[];
}

export interface SchemaImageInput {
  readonly url: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly alt?: string | null;
  /** Optional authoritative owning tenant ID; if present and `input.tenantId` is set, MUST match. */
  readonly tenantId?: string | null;
  /** Optional media processing status; when present, MUST be `"ready"`. */
  readonly status?: string | null;
  /** Optional DB media status; when present, MUST be `"ready"`. */
  readonly dbStatus?: string | null;
  /** Optional soft-delete timestamp; when non-null, media is trashed and omitted. */
  readonly deletedAt?: number | null;
  /** Marks a verified platform-level asset exempt from tenantId comparison. */
  readonly isPlatformFallback?: boolean;
}

export interface SchemaSocialLinkInput {
  readonly platform?: string | null;
  readonly url: string;
}

export interface SchemaBusinessHoursInput {
  readonly weekday?: string | null;
  readonly holiday?: string | null;
}

export interface SchemaBranchInput {
  readonly name: string;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly phone?: string | null;
  readonly whatsappNumber?: string | null;
  readonly mapsUrl?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly weekdayHours?: string | null;
  readonly holidayHours?: string | null;
  readonly openingHours?: SchemaBusinessHoursInput | null;
}

export interface SchemaBusinessProfileInput {
  readonly businessName?: string | null;
  readonly businessCategory?: string | null;
  readonly description?: string | null;
  readonly logo?: SchemaImageInput | null;
  readonly image?: SchemaImageInput | null;
  readonly phone?: string | null;
  readonly whatsappNumber?: string | null;
  readonly whatsappE164?: string | null;
  /** Public business contact email ONLY — never pass a private account/login email. */
  readonly publicEmail?: string | null;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly mapsUrl?: string | null;
  readonly weekdayHours?: string | null;
  readonly holidayHours?: string | null;
  readonly openingHours?: SchemaBusinessHoursInput | null;
  readonly serviceAreas?: readonly string[] | null;
  readonly socialLinks?: readonly (SchemaSocialLinkInput | string)[] | null;
  readonly sameAs?: readonly string[] | null;
  readonly branches?: readonly SchemaBranchInput[] | null;
}

export interface SchemaBreadcrumbItemInput {
  /** Exact visible breadcrumb label rendered on the page. */
  readonly label: string;
  /** Root-relative path resolved against the verified canonical origin (e.g. `"/"`, `"/blog"`). */
  readonly path?: string | null;
  /** Optional absolute HTTPS URL (MUST match the verified canonical origin). */
  readonly url?: string | null;
}

export interface SchemaFaqItemInput {
  readonly question: string;
  readonly answer: string;
}

export interface SchemaArticleInput {
  readonly schemaType?: AllowedArticleSchemaType | string | null;
  readonly headline: string;
  readonly description?: string | null;
  readonly datePublished?: string | number | Date | null;
  readonly dateModified?: string | number | Date | null;
  readonly authorName?: string | null;
  readonly authorRoleTitle?: string | null;
  readonly authorUrl?: string | null;
  readonly authorSameAs?: readonly string[] | null;
  readonly image?: SchemaImageInput | null;
  readonly section?: string | null;
  readonly tags?: readonly string[] | null;
  readonly inLanguage?: string | null;
}

export type SchemaOfferingAttributesInput = Partial<
  ServiceAttributes &
    ProductAttributes &
    TourAttributes &
    VehicleAttributes & {
      readonly vehicleYear?: number;
    }
>;

export interface SchemaOfferingInput {
  readonly offeringType: CatalogOfferingType;
  readonly title: string;
  readonly summary?: string | null;
  readonly priceMode?: CatalogPriceMode | null;
  readonly price?: number | null;
  readonly priceMax?: number | null;
  readonly negotiable?: boolean | null;
  readonly ctaMode?: CatalogCtaMode | null;
  readonly unitStatus?: CatalogVehicleUnitStatus | null;
  readonly categoryName?: string | null;
  readonly images?: readonly (SchemaImageInput | null | undefined)[] | null;
  readonly attributes?: SchemaOfferingAttributesInput | null;
}

export interface GenerateSchemaInput {
  /** Typed SEO policy input evaluated via TASK-051 `resolvePublishedSeoDecision`. */
  readonly seo: PublishedSeoDecisionInput;
  /** Authoritative tenant ID for media ownership checks. */
  readonly tenantId?: string | null;
  /** Visible public site name. */
  readonly siteName: string;
  /** Optional visible site tagline. */
  readonly siteTagline?: string | null;
  /** BCP-47 language tag (default `"id-ID"`). */
  readonly locale?: string | null;
  /** IANA timezone for date-only comparisons such as tour departure filtering (default `"Asia/Jakarta"`). */
  readonly timezone?: string | null;
  /** Optional visible published business profile feeding Organization / LocalBusiness / branches. */
  readonly business?: SchemaBusinessProfileInput | null;
  /** Visible page title/heading for `WebPage.name`. */
  readonly pageTitle?: string | null;
  /** Visible page summary/description for `WebPage.description`. */
  readonly pageDescription?: string | null;
  /** Optional page schema subtype from `ALLOWED_PAGE_SCHEMA_TYPES`. */
  readonly pageSchemaType?: string | null;
  readonly pageDatePublished?: string | number | Date | null;
  readonly pageDateModified?: string | number | Date | null;
  /** Ready primary image for the page. */
  readonly pageImage?: SchemaImageInput | null;
  /** Visible hierarchical breadcrumbs (emits `BreadcrumbList` only when non-empty). */
  readonly breadcrumbs?: readonly SchemaBreadcrumbItemInput[] | null;
  /** Visible FAQ Q&A items (emits `FAQPage` ONLY when >= 1 valid Q&A pair exists). */
  readonly faqItems?: readonly SchemaFaqItemInput[] | null;
  /** Visible published article details (emits `BlogPosting` / `Article` / `NewsArticle`). */
  readonly article?: SchemaArticleInput | null;
  /** Visible published typed offering details (`product` / `service` / `tour` / `vehicle`). */
  readonly offering?: SchemaOfferingInput | null;
  /**
   * Reference point in time used to filter out past `tour` departure dates (`REQ-095`).
   * Accepts a `YYYY-MM-DD` date string, ISO timestamp, epoch ms, or `Date`.
   */
  readonly now?: Date | string | number | null;
  /** Optional additional trusted HTTPS media CDN origins (e.g. `env.MEDIA_PUBLIC_BASE_URL`). */
  readonly allowedMediaOrigins?: readonly string[];
}

export interface SchemaGenerationResult {
  readonly emitted: boolean;
  readonly suppressionReason: SchemaSuppressionReason | null;
  readonly verifiedOrigin: string | null;
  readonly canonicalUrl: string | null;
  readonly graph: SchemaGraphDocument | null;
  readonly nodes: readonly SchemaNode[];
  /** Safely escaped JSON-LD string via TASK-051 `safeJsonLdStringify`, or `null` when suppressed. */
  readonly jsonLd: string | null;
  /** Ready-to-embed `<script type="application/ld+json">...</script>` tag, or `null` when suppressed. */
  readonly scriptTag: string | null;
  readonly seoDecision: PublishedSeoDecision;
  readonly policy: SchemaPolicyMetadata;
}

// ---------------------------------------------------------------------------
// Internal Lookup Tables & Sanitizers
// ---------------------------------------------------------------------------

const BUSINESS_TYPE_BY_LOWER: ReadonlyMap<string, AllowedBusinessSchemaType> = new Map(
  ALLOWED_BUSINESS_SCHEMA_TYPES.map((typeName) => [typeName.toLowerCase(), typeName]),
);

const BUSINESS_CATEGORY_ALIASES: Readonly<Record<string, AllowedBusinessSchemaType>> = {
  organization: "Organization",
  company: "Organization",
  corporate: "Organization",
  b2b_corporate: "Organization",
  local_business: "LocalBusiness",
  localbusiness: "LocalBusiness",
  offline_multibranch: "LocalBusiness",
  travel: "TravelAgency",
  travel_agency: "TravelAgency",
  travel_umrah_agency: "TravelAgency",
  umrah: "TravelAgency",
  dealer: "AutoDealer",
  auto_dealer: "AutoDealer",
  car_dealer: "AutoDealer",
  motorcycle_dealer: "MotorcycleDealer",
  resto: "Restaurant",
  restaurant: "Restaurant",
  cafe: "CafeOrCoffeeShop",
  coffee_shop: "CafeOrCoffeeShop",
  bakery: "Bakery",
  store: "Store",
  shop: "Store",
  catalog: "Store",
  wa_catalog_showcase: "Store",
  clinic: "MedicalClinic",
  medical_clinic: "MedicalClinic",
  dentist: "Dentist",
  legal: "LegalService",
  law_firm: "LegalService",
  accounting: "AccountingService",
  real_estate: "RealEstateAgent",
  property: "RealEstateAgent",
  contractor: "HomeAndConstructionBusiness",
  construction: "HomeAndConstructionBusiness",
  beauty_salon: "BeautySalon",
  salon: "BeautySalon",
  education: "EducationalOrganization",
  course: "EducationalOrganization",
  hotel: "Hotel",
  lodging: "LodgingBusiness",
};

const PAGE_TYPE_BY_LOWER: ReadonlyMap<string, AllowedPageSchemaType> = new Map(
  ALLOWED_PAGE_SCHEMA_TYPES.map((typeName) => [typeName.toLowerCase(), typeName]),
);

const ARTICLE_TYPE_BY_LOWER: ReadonlyMap<string, AllowedArticleSchemaType> = new Map(
  ALLOWED_ARTICLE_SCHEMA_TYPES.map((typeName) => [typeName.toLowerCase(), typeName]),
);

const CAR_BODY_TYPES = new Set<string>([
  "mpv",
  "suv",
  "sedan",
  "hatchback",
  "pickup",
  "double_cabin",
  "crossover",
]);

const PRODUCT_STOCK_AVAILABILITY: Readonly<Record<string, string>> = {
  ready: "https://schema.org/InStock",
  preorder: "https://schema.org/PreOrder",
  limited: "https://schema.org/LimitedAvailability",
  out_of_stock: "https://schema.org/OutOfStock",
};

const VEHICLE_UNIT_AVAILABILITY: Readonly<Record<CatalogVehicleUnitStatus, string>> = {
  available: "https://schema.org/InStock",
  booked: "https://schema.org/LimitedAvailability",
  sold: "https://schema.org/OutOfStock",
};

const VEHICLE_TRANSMISSION_LABELS: Readonly<Record<string, string>> = {
  manual: "Manual",
  automatic: "Automatic",
  cvt: "CVT",
  dct: "DCT",
  ev: "Electric",
};

const VEHICLE_FUEL_LABELS: Readonly<Record<string, string>> = {
  bensin: "Gasoline",
  diesel: "Diesel",
  hybrid: "Hybrid",
  listrik: "Electric",
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_URL_LENGTH = 2048;

function hasAsciiControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isIpv4OrPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".localdomain") ||
    lower.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (lower.includes(":") || lower.startsWith("[")) {
    return true;
  }
  const labels = lower.split(".");
  if (labels.length <= 4 && labels.every((l) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(l))) {
    return true;
  }
  return false;
}

function normalizeLanguageTag(raw?: string | null): string {
  if (typeof raw !== "string") {
    return SCHEMA_DEFAULT_LANGUAGE;
  }
  const cleaned = sanitizeSeoText(raw, { maxLength: 16 });
  if (!cleaned) {
    return SCHEMA_DEFAULT_LANGUAGE;
  }
  const parts = cleaned.split(/[-_]/);
  const lang = parts[0]?.toLowerCase() ?? "";
  const region = parts[1]?.toUpperCase() ?? "";
  if (/^[a-z]{2,3}$/.test(lang) && /^[A-Z]{2}$/.test(region)) {
    return `${lang}-${region}`;
  }
  if (/^[a-z]{2,3}$/.test(lang)) {
    return lang;
  }
  return SCHEMA_DEFAULT_LANGUAGE;
}

function normalizeIsoTimestamp(value: string | number | Date | null | undefined): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === "string") {
    if (hasAsciiControlChars(value)) {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) {
      return null;
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function isValidCalendarDate(raw: string): boolean {
  const match = ISO_DATE_PATTERN.exec(raw);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function resolveReferenceCalendarDate(
  now: Date | string | number | null | undefined,
  timezone?: string | null,
): string | null {
  if (now === undefined || now === null || now === "") {
    return null;
  }
  if (typeof now === "string") {
    const trimmed = now.trim();
    if (isValidCalendarDate(trimmed)) {
      return trimmed;
    }
  }
  const dateObj =
    now instanceof Date
      ? now
      : typeof now === "number"
        ? new Date(now)
        : typeof now === "string"
          ? new Date(now)
          : null;
  if (!dateObj || !Number.isFinite(dateObj.getTime())) {
    return null;
  }

  const tz = sanitizeSeoText(timezone ?? SCHEMA_DEFAULT_TIMEZONE, { maxLength: 64 }) || SCHEMA_DEFAULT_TIMEZONE;
  try {
    // en-CA formats YYYY-MM-DD deterministically in Node and Cloudflare Workers
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(dateObj);
    if (isValidCalendarDate(formatted)) {
      return formatted;
    }
  } catch {
    // Fall back safely to UTC calendar date if timezone string is unsupported
  }
  return dateObj.toISOString().slice(0, 10);
}

/**
 * Filters a list of ISO `YYYY-MM-DD` tour departure dates:
 * - Drops malformed calendar dates.
 * - When `now` is provided, strictly omits all past dates (`date < referenceDate`).
 * - Deduplicates and sorts ascending.
 */
export function filterUpcomingDepartureDates(
  dates: readonly string[],
  now?: Date | string | number | null,
  timezone?: string | null,
): readonly string[] {
  const referenceDate = resolveReferenceCalendarDate(now, timezone);
  const unique = new Set<string>();
  for (const raw of dates) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!isValidCalendarDate(trimmed)) continue;
    if (referenceDate !== null && trimmed < referenceDate) {
      continue;
    }
    unique.add(trimmed);
  }
  return Array.from(unique).sort();
}

/**
 * Resolves a closed business category string into a valid Schema.org Organization /
 * LocalBusiness subtype. Explicitly rejects deprecated `ProfessionalService` (REQ-091, PLAN §15.4).
 */
export function resolveBusinessSchemaType(
  rawCategory?: string | null,
): AllowedBusinessSchemaType {
  if (typeof rawCategory !== "string") {
    return "LocalBusiness";
  }
  const cleaned = sanitizeSeoText(rawCategory, { maxLength: 80 });
  if (!cleaned) {
    return "LocalBusiness";
  }
  const lower = cleaned.toLowerCase();
  if (lower === "professionalservice" || lower === "professional_service") {
    return "LocalBusiness";
  }
  const exact = BUSINESS_TYPE_BY_LOWER.get(lower);
  if (exact) {
    return exact;
  }
  const alias = BUSINESS_CATEGORY_ALIASES[lower];
  if (alias) {
    return alias;
  }
  return "LocalBusiness";
}

function validatePublicHttpsUrl(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== "string" || hasAsciiControlChars(rawUrl)) {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_URL_LENGTH ||
    !/^https:\/\//i.test(trimmed) ||
    /[\\<>"'\s]/.test(trimmed)
  ) {
    return null;
  }
  const afterScheme = trimmed.slice(8);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (!rawAuthority || rawAuthority.includes("@") || rawAuthority.includes(":")) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    return null;
  }
  if (isIpv4OrPrivateHost(parsed.hostname) || !parsed.hostname.includes(".")) {
    return null;
  }
  return parsed.toString();
}

function validateTrustedMediaOrigin(rawOrigin: string): string | null {
  if (typeof rawOrigin !== "string" || hasAsciiControlChars(rawOrigin)) {
    return null;
  }
  const trimmed = rawOrigin.trim().replace(/\/+$/, "");
  if (!trimmed || !/^https:\/\//i.test(trimmed)) {
    return null;
  }
  const afterScheme = trimmed.slice(8);
  if (
    !afterScheme ||
    afterScheme.includes("@") ||
    /[/?#\\<>"'\s]/.test(afterScheme) ||
    afterScheme.includes(":")
  ) {
    return null;
  }
  const host = afterScheme.toLowerCase().replace(/\.$/, "");
  const platformMediaSuffix = `.${PLATFORM_HOSTS.marketing}`;
  if (host.endsWith(platformMediaSuffix)) {
    const label = host.slice(0, -platformMediaSuffix.length);
    if (label && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return `https://${host}`;
    }
    return null;
  }
  try {
    const validatedHost = validateCanonicalHostname(host);
    return `https://${validatedHost}`;
  } catch {
    return null;
  }
}

function buildAllowedImageOrigins(
  verifiedOrigin: string,
  extraMediaOrigins?: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set<string>([SCHEMA_DEFAULT_MEDIA_CDN_ORIGIN]);
  try {
    allowed.add(validateCanonicalOrigin(verifiedOrigin));
  } catch {
    // Ignore invalid origin
  }
  if (extraMediaOrigins) {
    for (const raw of extraMediaOrigins) {
      const valid = validateTrustedMediaOrigin(raw);
      if (valid) {
        allowed.add(valid);
      }
    }
  }
  return allowed;
}

interface ResolvedSchemaImage {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
}

function resolveValidatedSchemaImage(
  candidate: SchemaImageInput | null | undefined,
  options: {
    readonly tenantId: string | null;
    readonly allowedOrigins: ReadonlySet<string>;
  },
): ResolvedSchemaImage | null {
  if (!candidate || typeof candidate.url !== "string") {
    return null;
  }
  // Reject non-ready or trashed media assets
  if (candidate.deletedAt !== undefined && candidate.deletedAt !== null) {
    return null;
  }
  if (
    candidate.status !== undefined &&
    candidate.status !== null &&
    candidate.status !== "ready"
  ) {
    return null;
  }
  if (
    candidate.dbStatus !== undefined &&
    candidate.dbStatus !== null &&
    candidate.dbStatus !== "ready"
  ) {
    return null;
  }
  // Reject cross-tenant media when both tenant IDs are known
  if (
    !candidate.isPlatformFallback &&
    options.tenantId &&
    candidate.tenantId &&
    candidate.tenantId.trim() !== options.tenantId
  ) {
    return null;
  }

  const rawUrl = candidate.url.trim();
  if (hasAsciiControlChars(rawUrl) || rawUrl.includes("..") || /%(?:2e|2f|5c|00)/i.test(rawUrl)) {
    return null;
  }
  const safeUrl = validatePublicHttpsUrl(rawUrl);
  if (!safeUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(safeUrl);
  } catch {
    return null;
  }
  const origin = validateTrustedMediaOrigin(`https://${parsed.hostname}`);
  if (!origin || !options.allowedOrigins.has(origin)) {
    return null;
  }

  // Enforce tenant path scoping on media CDN paths when tenantId is provided
  if (
    !candidate.isPlatformFallback &&
    options.tenantId &&
    parsed.pathname.startsWith("/t/") &&
    !parsed.pathname.startsWith(`/t/${options.tenantId}/`)
  ) {
    return null;
  }

  const width =
    typeof candidate.width === "number" && Number.isSafeInteger(candidate.width) && candidate.width > 0
      ? candidate.width
      : undefined;
  const height =
    typeof candidate.height === "number" &&
    Number.isSafeInteger(candidate.height) &&
    candidate.height > 0
      ? candidate.height
      : undefined;
  const alt = candidate.alt ? sanitizeSeoText(candidate.alt, { maxLength: 250 }) : undefined;

  return {
    url: safeUrl,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(alt ? { alt } : {}),
  };
}

function toImageObject(image: ResolvedSchemaImage): Record<string, unknown> {
  return {
    "@type": "ImageObject",
    url: image.url,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
    ...(image.alt ? { caption: image.alt } : {}),
  };
}

function sanitizeTelephone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || hasAsciiControlChars(raw)) {
    return null;
  }
  const cleaned = sanitizeSeoText(raw, { maxLength: 32 });
  if (!cleaned) {
    return null;
  }
  const stripped = cleaned.replace(/[\s()-]/g, "");
  if (/^\+[0-9]{8,15}$/.test(stripped)) {
    return stripped;
  }
  if (/^62[0-9]{7,13}$/.test(stripped)) {
    return `+${stripped}`;
  }
  if (/^0[0-9]{7,13}$/.test(stripped)) {
    return `+62${stripped.slice(1)}`;
  }
  if (/^[0-9]{8,15}$/.test(stripped)) {
    return `+${stripped}`;
  }
  return null;
}

function sanitizePublicEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || hasAsciiControlChars(raw)) {
    return null;
  }
  const cleaned = sanitizeSeoText(raw, { maxLength: 254 });
  if (!cleaned || /\s/.test(cleaned)) {
    return null;
  }
  // Basic RFC-style structural validation without over-permissive chars
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function buildPostalAddress(fields: {
  readonly address?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
}): Record<string, unknown> | null {
  const streetAddress = fields.address ? sanitizeSeoText(fields.address, { maxLength: 500 }) : "";
  const addressLocality = fields.city ? sanitizeSeoText(fields.city, { maxLength: 120 }) : "";
  const addressRegion = fields.province ? sanitizeSeoText(fields.province, { maxLength: 120 }) : "";
  const postalCode = fields.postalCode ? sanitizeSeoText(fields.postalCode, { maxLength: 20 }) : "";

  if (!streetAddress && !addressLocality && !addressRegion && !postalCode) {
    return null;
  }

  const country = fields.country
    ? sanitizeSeoText(fields.country, { maxLength: 2 }).toUpperCase() || "ID"
    : "ID";

  return {
    "@type": "PostalAddress",
    ...(streetAddress ? { streetAddress } : {}),
    ...(addressLocality ? { addressLocality } : {}),
    ...(addressRegion ? { addressRegion } : {}),
    ...(postalCode ? { postalCode } : {}),
    addressCountry: country,
  };
}

function buildGeoCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): Record<string, unknown> | null {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return {
    "@type": "GeoCoordinates",
    latitude,
    longitude,
  };
}

function collectOpeningHours(
  weekdayHours?: string | null,
  holidayHours?: string | null,
  openingHours?: SchemaBusinessHoursInput | null,
): readonly string[] {
  const out: string[] = [];
  const weekday = sanitizeSeoText(weekdayHours ?? openingHours?.weekday ?? "", { maxLength: 160 });
  const holiday = sanitizeSeoText(holidayHours ?? openingHours?.holiday ?? "", { maxLength: 160 });
  if (weekday) out.push(weekday);
  if (holiday && holiday !== weekday) out.push(holiday);
  return out;
}

function collectValidatedSameAs(
  socialLinks?: readonly (SchemaSocialLinkInput | string)[] | null,
  sameAs?: readonly string[] | null,
): readonly string[] {
  const unique = new Set<string>();
  if (socialLinks) {
    for (const entry of socialLinks) {
      const rawUrl = typeof entry === "string" ? entry : entry.url;
      const valid = validatePublicHttpsUrl(rawUrl);
      if (valid) {
        unique.add(valid);
      }
    }
  }
  if (sameAs) {
    for (const rawUrl of sameAs) {
      const valid = validatePublicHttpsUrl(rawUrl);
      if (valid) {
        unique.add(valid);
      }
    }
  }
  return Array.from(unique);
}

function resolveCanonicalBreadcrumbUrl(
  item: SchemaBreadcrumbItemInput,
  verifiedOrigin: string,
): string | null {
  if (item.path !== undefined && item.path !== null && item.path.trim() !== "") {
    try {
      const { normalizedPath } = normalizePublicPath(item.path);
      return `${verifiedOrigin}${normalizedPath}`;
    } catch {
      return null;
    }
  }
  if (item.url !== undefined && item.url !== null && item.url.trim() !== "") {
    try {
      return validateCanonicalOverride(item.url, verifiedOrigin);
    } catch {
      return null;
    }
  }
  return null;
}

function resolveSuppressionReason(decision: PublishedSeoDecision): SchemaSuppressionReason | null {
  if (
    decision.reason === "private_or_preview_route" ||
    decision.reason === "unknown_or_unverified_host" ||
    decision.reason === "error_route"
  ) {
    return "non_public_route";
  }
  if (
    decision.reason === "tenant_not_found_or_destroyed" ||
    decision.reason === "tenant_suspended" ||
    decision.reason === "tenant_recovery"
  ) {
    return "non_serving_tenant";
  }
  if (
    decision.reason === "resource_not_published" ||
    decision.reason === "invalid_pagination" ||
    decision.reason === "out_of_range_pagination"
  ) {
    return "unpublished_resource";
  }
  if (
    decision.reason === "former_slug_redirect" ||
    decision.reason === "homepage_slug_redirect" ||
    decision.reason === "alias_host_redirect"
  ) {
    return "redirect_route";
  }
  if (decision.httpStatus !== 200 || decision.canonical === null) {
    return "missing_canonical";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node Builders
// ---------------------------------------------------------------------------

function buildWebsiteNode(params: {
  readonly verifiedOrigin: string;
  readonly siteName: string;
  readonly siteTagline?: string | null;
  readonly inLanguage: string;
  readonly hasOrganizationNode: boolean;
}): SchemaNode {
  const description = params.siteTagline
    ? sanitizeSeoText(params.siteTagline, { maxLength: 240 })
    : "";
  return {
    "@type": "WebSite",
    "@id": `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.website}`,
    url: `${params.verifiedOrigin}/`,
    name: params.siteName,
    ...(description ? { description } : {}),
    inLanguage: params.inLanguage,
    ...(params.hasOrganizationNode
      ? {
          publisher: {
            "@id": `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.organization}`,
          },
        }
      : {}),
  };
}

function buildOrganizationAndBranchNodes(params: {
  readonly verifiedOrigin: string;
  readonly siteName: string;
  readonly business: SchemaBusinessProfileInput | null | undefined;
  readonly tenantId: string | null;
  readonly allowedOrigins: ReadonlySet<string>;
}): readonly SchemaNode[] {
  const business = params.business;
  const orgId = `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.organization}`;
  const businessName =
    (business?.businessName ? sanitizeSeoText(business.businessName, { maxLength: 160 }) : "") ||
    params.siteName;
  const schemaType = resolveBusinessSchemaType(business?.businessCategory ?? "Organization");
  const description = business?.description
    ? sanitizeSeoText(business.description, { maxLength: 1000 })
    : "";

  const logo = resolveValidatedSchemaImage(business?.logo, {
    tenantId: params.tenantId,
    allowedOrigins: params.allowedOrigins,
  });
  const image = resolveValidatedSchemaImage(business?.image, {
    tenantId: params.tenantId,
    allowedOrigins: params.allowedOrigins,
  });

  const telephone =
    sanitizeTelephone(business?.phone) ??
    sanitizeTelephone(business?.whatsappE164 ?? business?.whatsappNumber);
  const email = sanitizePublicEmail(business?.publicEmail);
  const address = buildPostalAddress({
    address: business?.address,
    city: business?.city,
    province: business?.province,
    postalCode: business?.postalCode,
    country: business?.country,
  });
  const geo = buildGeoCoordinates(business?.latitude, business?.longitude);
  const hasMap = validatePublicHttpsUrl(business?.mapsUrl);
  const openingHours = collectOpeningHours(
    business?.weekdayHours,
    business?.holidayHours,
    business?.openingHours,
  );
  const serviceAreas = (business?.serviceAreas ?? [])
    .map((area) => sanitizeSeoText(area, { maxLength: 80 }))
    .filter((area) => area.length > 0);
  const sameAs = collectValidatedSameAs(business?.socialLinks, business?.sameAs);

  // Build optional branch nodes (REQ-088: up to 10 branches, same Schema.org subtype)
  const branchNodes: SchemaNode[] = [];
  const branchRefs: { readonly "@id": string }[] = [];
  const rawBranches = (business?.branches ?? []).slice(0, 10);
  const branchType: AllowedBusinessSchemaType =
    schemaType === "Organization" ? "LocalBusiness" : schemaType;

  for (let i = 0; i < rawBranches.length; i += 1) {
    const branch = rawBranches[i];
    if (!branch) continue;
    const branchName = sanitizeSeoText(branch.name, { maxLength: 120 });
    if (!branchName) continue;

    const branchId = `${params.verifiedOrigin}/#branch-${i + 1}`;
    const branchAddress = buildPostalAddress({
      address: branch.address,
      city: branch.city,
      province: branch.province,
      postalCode: branch.postalCode,
      country: branch.country,
    });
    const branchPhone =
      sanitizeTelephone(branch.phone) ?? sanitizeTelephone(branch.whatsappNumber);
    const branchGeo = buildGeoCoordinates(branch.latitude, branch.longitude);
    const branchMap = validatePublicHttpsUrl(branch.mapsUrl);
    const branchHours = collectOpeningHours(
      branch.weekdayHours,
      branch.holidayHours,
      branch.openingHours,
    );

    branchRefs.push({ "@id": branchId });
    branchNodes.push({
      "@type": branchType,
      "@id": branchId,
      name: branchName,
      url: `${params.verifiedOrigin}/`,
      parentOrganization: { "@id": orgId },
      ...(branchAddress ? { address: branchAddress } : {}),
      ...(branchPhone ? { telephone: branchPhone } : {}),
      ...(branchGeo ? { geo: branchGeo } : {}),
      ...(branchMap ? { hasMap: branchMap } : {}),
      ...(branchHours.length > 0 ? { openingHours: branchHours } : {}),
    });
  }

  const orgNode: SchemaNode = {
    "@type": schemaType,
    "@id": orgId,
    name: businessName,
    url: `${params.verifiedOrigin}/`,
    ...(description ? { description } : {}),
    ...(logo ? { logo: toImageObject(logo) } : {}),
    ...(image ? { image: image.url } : logo ? { image: logo.url } : {}),
    ...(telephone ? { telephone } : {}),
    ...(email ? { email } : {}),
    ...(address ? { address } : {}),
    ...(geo ? { geo } : {}),
    ...(hasMap ? { hasMap } : {}),
    ...(openingHours.length > 0 ? { openingHours } : {}),
    ...(serviceAreas.length > 0 ? { areaServed: serviceAreas } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    ...(branchRefs.length > 0 ? { subOrganization: branchRefs } : {}),
  };

  return [orgNode, ...branchNodes];
}

function buildBreadcrumbNode(
  breadcrumbs: readonly SchemaBreadcrumbItemInput[] | null | undefined,
  verifiedOrigin: string,
  canonicalUrl: string,
): SchemaNode | null {
  if (!breadcrumbs || breadcrumbs.length === 0) {
    return null;
  }
  const listItems: Record<string, unknown>[] = [];
  for (const crumb of breadcrumbs) {
    const label = sanitizeSeoText(crumb.label, { maxLength: 160 });
    if (!label) continue;
    const itemUrl = resolveCanonicalBreadcrumbUrl(crumb, verifiedOrigin);
    if (!itemUrl) continue;
    listItems.push({
      "@type": "ListItem",
      position: listItems.length + 1,
      name: label,
      item: itemUrl,
    });
  }
  if (listItems.length === 0) {
    return null;
  }
  return {
    "@type": "BreadcrumbList",
    "@id": `${canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.breadcrumb}`,
    itemListElement: listItems,
  };
}

function resolvePageSchemaType(
  routeKind: SeoRouteKind,
  requestedType?: string | null,
): AllowedPageSchemaType {
  if (typeof requestedType === "string") {
    const cleaned = sanitizeSeoText(requestedType, { maxLength: 64 }).toLowerCase();
    // FAQPage is emitted as its own node only when visible FAQ items exist; WebPage keeps valid page type.
    const matched = PAGE_TYPE_BY_LOWER.get(cleaned);
    if (matched) {
      return matched;
    }
  }
  if (
    routeKind === "blog_index" ||
    routeKind === "catalog_index" ||
    routeKind === "category_archive" ||
    routeKind === "tag_archive" ||
    routeKind === "offering_category_archive"
  ) {
    return "CollectionPage";
  }
  return "WebPage";
}

function buildWebPageNode(params: {
  readonly routeKind: SeoRouteKind;
  readonly verifiedOrigin: string;
  readonly canonicalUrl: string;
  readonly pageTitle: string;
  readonly pageDescription?: string | null;
  readonly pageSchemaType?: string | null;
  readonly datePublished?: string | number | Date | null;
  readonly dateModified?: string | number | Date | null;
  readonly primaryImage: ResolvedSchemaImage | null;
  readonly inLanguage: string;
  readonly hasBreadcrumb: boolean;
  readonly mainEntityId?: string | null;
}): SchemaNode {
  const pageType = resolvePageSchemaType(params.routeKind, params.pageSchemaType);
  const description = params.pageDescription
    ? sanitizeSeoText(params.pageDescription, { maxLength: 500 })
    : "";
  const datePublished = normalizeIsoTimestamp(params.datePublished);
  const dateModified = normalizeIsoTimestamp(params.dateModified);

  return {
    "@type": pageType,
    "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.webpage}`,
    url: params.canonicalUrl,
    name: params.pageTitle,
    ...(description ? { description } : {}),
    inLanguage: params.inLanguage,
    isPartOf: { "@id": `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.website}` },
    ...(params.routeKind === "homepage"
      ? { about: { "@id": `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.organization}` } }
      : {}),
    ...(params.hasBreadcrumb
      ? { breadcrumb: { "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.breadcrumb}` } }
      : {}),
    ...(params.mainEntityId ? { mainEntity: { "@id": params.mainEntityId } } : {}),
    ...(datePublished ? { datePublished } : {}),
    ...(dateModified ? { dateModified } : {}),
    ...(params.primaryImage ? { primaryImageOfPage: toImageObject(params.primaryImage) } : {}),
  };
}

function buildFaqNode(
  faqItems: readonly SchemaFaqItemInput[] | null | undefined,
  canonicalUrl: string,
): SchemaNode | null {
  if (!faqItems || faqItems.length === 0) {
    return null;
  }
  const questions: Record<string, unknown>[] = [];
  for (const item of faqItems) {
    const question = sanitizeSeoText(item.question, { maxLength: 300 });
    const answer = sanitizeSeoText(item.answer, { maxLength: 2000 });
    if (!question || !answer) continue;
    questions.push({
      "@type": "Question",
      name: question,
      acceptedAnswer: {
        "@type": "Answer",
        text: answer,
      },
    });
  }
  if (questions.length === 0) {
    return null;
  }
  return {
    "@type": "FAQPage",
    "@id": `${canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.faq}`,
    url: canonicalUrl,
    isPartOf: { "@id": `${canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.webpage}` },
    mainEntity: questions,
  };
}

function buildArticleNode(params: {
  readonly article: SchemaArticleInput;
  readonly verifiedOrigin: string;
  readonly canonicalUrl: string;
  readonly defaultLanguage: string;
  readonly tenantId: string | null;
  readonly allowedOrigins: ReadonlySet<string>;
}): SchemaNode | null {
  const headline = sanitizeSeoText(params.article.headline, { maxLength: 200 });
  if (!headline) {
    return null;
  }
  const requestedType = params.article.schemaType
    ? sanitizeSeoText(params.article.schemaType, { maxLength: 64 }).toLowerCase()
    : "";
  const articleType: AllowedArticleSchemaType =
    ARTICLE_TYPE_BY_LOWER.get(requestedType) ?? "BlogPosting";

  const description = params.article.description
    ? sanitizeSeoText(params.article.description, { maxLength: 500 })
    : "";
  const datePublished = normalizeIsoTimestamp(params.article.datePublished);
  const dateModified = normalizeIsoTimestamp(params.article.dateModified);
  const authorName = params.article.authorName
    ? sanitizeSeoText(params.article.authorName, { maxLength: 120 })
    : "";
  const authorRole = params.article.authorRoleTitle
    ? sanitizeSeoText(params.article.authorRoleTitle, { maxLength: 120 })
    : "";
  const authorUrl = validatePublicHttpsUrl(params.article.authorUrl);
  const authorSameAs = collectValidatedSameAs(null, params.article.authorSameAs);

  const image = resolveValidatedSchemaImage(params.article.image, {
    tenantId: params.tenantId,
    allowedOrigins: params.allowedOrigins,
  });
  const section = params.article.section
    ? sanitizeSeoText(params.article.section, { maxLength: 100 })
    : "";
  const tags = (params.article.tags ?? [])
    .map((t) => sanitizeSeoText(t, { maxLength: 80 }))
    .filter((t) => t.length > 0);
  const inLanguage = params.article.inLanguage
    ? normalizeLanguageTag(params.article.inLanguage)
    : params.defaultLanguage;

  const authorNode = authorName
    ? {
        "@type": "Person",
        name: authorName,
        ...(authorRole ? { jobTitle: authorRole } : {}),
        ...(authorUrl ? { url: authorUrl } : {}),
        ...(authorSameAs.length > 0 ? { sameAs: authorSameAs } : {}),
      }
    : null;

  return {
    "@type": articleType,
    "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.article}`,
    headline,
    ...(description ? { description } : {}),
    url: params.canonicalUrl,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.webpage}`,
      url: params.canonicalUrl,
    },
    ...(datePublished ? { datePublished } : {}),
    ...(dateModified ? { dateModified } : {}),
    ...(authorNode ? { author: authorNode } : {}),
    publisher: { "@id": `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.organization}` },
    ...(image ? { image: toImageObject(image) } : {}),
    ...(section ? { articleSection: section } : {}),
    ...(tags.length > 0 ? { keywords: tags } : {}),
    inLanguage,
  };
}

function isValidIdrInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 999_999_999_999
  );
}

/**
 * Builds an honest Schema.org `Offer` or `AggregateOffer` ONLY when concrete numeric
 * pricing is visible and the item is NOT `on_request` or `inquiry`.
 * Never invents prices, stock/availability, shipping, or merchant-return properties.
 */
function buildHonestOffer(params: {
  readonly priceMode: CatalogPriceMode | null | undefined;
  readonly price: number | null | undefined;
  readonly priceMax: number | null | undefined;
  readonly ctaMode: CatalogCtaMode | null | undefined;
  readonly canonicalUrl: string;
  readonly availability?: string | null;
}): Record<string, unknown> | null {
  if (params.ctaMode === "inquiry") {
    return null;
  }
  if (!params.priceMode || params.priceMode === "on_request") {
    return null;
  }
  if (!isValidIdrInteger(params.price)) {
    return null;
  }

  const availabilityProp = params.availability ? { availability: params.availability } : {};

  if (params.priceMode === "fixed") {
    return {
      "@type": "Offer",
      priceCurrency: SCHEMA_CURRENCY_IDR,
      price: params.price,
      url: params.canonicalUrl,
      ...availabilityProp,
    };
  }

  if (params.priceMode === "from") {
    return {
      "@type": "AggregateOffer",
      priceCurrency: SCHEMA_CURRENCY_IDR,
      lowPrice: params.price,
      url: params.canonicalUrl,
      ...availabilityProp,
    };
  }

  if (params.priceMode === "range") {
    if (!isValidIdrInteger(params.priceMax) || params.priceMax < params.price) {
      return null;
    }
    return {
      "@type": "AggregateOffer",
      priceCurrency: SCHEMA_CURRENCY_IDR,
      lowPrice: params.price,
      highPrice: params.priceMax,
      url: params.canonicalUrl,
      ...availabilityProp,
    };
  }

  return null;
}

function collectOfferingImageUrls(
  images: readonly (SchemaImageInput | null | undefined)[] | null | undefined,
  options: {
    readonly tenantId: string | null;
    readonly allowedOrigins: ReadonlySet<string>;
  },
): readonly string[] {
  if (!images || images.length === 0) {
    return [];
  }
  const unique = new Set<string>();
  for (const img of images) {
    const resolved = resolveValidatedSchemaImage(img, options);
    if (resolved) {
      unique.add(resolved.url);
    }
  }
  return Array.from(unique);
}

function buildOfferingNode(params: {
  readonly offering: SchemaOfferingInput;
  readonly verifiedOrigin: string;
  readonly canonicalUrl: string;
  readonly tenantId: string | null;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly now?: Date | string | number | null;
  readonly timezone?: string | null;
}): SchemaNode | null {
  const { offering } = params;
  const name = sanitizeSeoText(offering.title, { maxLength: 200 });
  if (!name) {
    return null;
  }
  const description = offering.summary
    ? sanitizeSeoText(offering.summary, { maxLength: 500 })
    : "";
  const category = offering.categoryName
    ? sanitizeSeoText(offering.categoryName, { maxLength: 100 })
    : "";
  const imageUrls = collectOfferingImageUrls(offering.images, {
    tenantId: params.tenantId,
    allowedOrigins: params.allowedOrigins,
  });
  const attrs = offering.attributes ?? {};

  switch (offering.offeringType) {
    case "product": {
      const sku = typeof attrs.sku === "string" ? sanitizeSeoText(attrs.sku, { maxLength: 64 }) : "";
      const brandName =
        typeof attrs.brand === "string" ? sanitizeSeoText(attrs.brand, { maxLength: 100 }) : "";
      const material =
        typeof attrs.material === "string"
          ? sanitizeSeoText(attrs.material, { maxLength: 120 })
          : "";
      const availability =
        typeof attrs.stockStatus === "string"
          ? (PRODUCT_STOCK_AVAILABILITY[attrs.stockStatus] ?? null)
          : null;

      const specs = Array.isArray(attrs.specs)
        ? attrs.specs
            .map((spec) => {
              const specName = sanitizeSeoText(spec.label, { maxLength: 80 });
              const specValue = sanitizeSeoText(spec.value, { maxLength: 200 });
              if (!specName || !specValue) return null;
              return { "@type": "PropertyValue", name: specName, value: specValue };
            })
            .filter((item): item is { "@type": "PropertyValue"; name: string; value: string } => item !== null)
        : [];

      const offers = buildHonestOffer({
        priceMode: offering.priceMode,
        price: offering.price,
        priceMax: offering.priceMax,
        ctaMode: offering.ctaMode,
        canonicalUrl: params.canonicalUrl,
        availability,
      });

      return {
        "@type": "Product",
        "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.product}`,
        name,
        url: params.canonicalUrl,
        ...(description ? { description } : {}),
        ...(imageUrls.length > 0 ? { image: imageUrls } : {}),
        ...(sku ? { sku } : {}),
        ...(brandName ? { brand: { "@type": "Brand", name: brandName } } : {}),
        ...(material ? { material } : {}),
        ...(category ? { category } : {}),
        ...(specs.length > 0 ? { additionalProperty: specs } : {}),
        ...(offers ? { offers } : {}),
      };
    }

    case "service": {
      // Service / inquiry items ALWAYS emit `Service` — NEVER `Product`, NEVER invented `Offer`!
      const serviceArea =
        typeof attrs.serviceArea === "string"
          ? sanitizeSeoText(attrs.serviceArea, { maxLength: 160 })
          : "";
      return {
        "@type": "Service",
        "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.service}`,
        name,
        url: params.canonicalUrl,
        ...(description ? { description } : {}),
        provider: { "@id": `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.organization}` },
        ...(imageUrls.length > 0 ? { image: imageUrls } : {}),
        ...(category ? { serviceType: category } : {}),
        ...(serviceArea ? { areaServed: serviceArea } : {}),
      };
    }

    case "tour": {
      const destination =
        typeof attrs.destination === "string"
          ? sanitizeSeoText(attrs.destination, { maxLength: 160 })
          : "";
      const durationDays =
        typeof attrs.durationDays === "number" &&
        Number.isSafeInteger(attrs.durationDays) &&
        attrs.durationDays >= 1 &&
        attrs.durationDays <= 90
          ? attrs.durationDays
          : null;

      // Collect candidate departure dates from both `departures` objects and `departureDates` strings
      const rawDepartureDates: string[] = [];
      if (Array.isArray(attrs.departures)) {
        for (const dep of attrs.departures) {
          if (dep.status === "closed") continue;
          rawDepartureDates.push(dep.departureDate);
        }
      }
      if (Array.isArray(attrs.departureDates)) {
        for (const d of attrs.departureDates) {
          rawDepartureDates.push(d);
        }
      }
      const upcomingDepartureDates = filterUpcomingDepartureDates(
        rawDepartureDates,
        params.now,
        params.timezone,
      );

      let itinerary: Record<string, unknown> | null = null;
      if (Array.isArray(attrs.itinerary) && attrs.itinerary.length > 0) {
        const items = attrs.itinerary
          .map((dayItem) => {
            const dayTitle = sanitizeSeoText(dayItem.title, { maxLength: 160 });
            if (!dayTitle) return null;
            const dayDesc = dayItem.description
              ? sanitizeSeoText(dayItem.description, { maxLength: 500 })
              : "";
            return {
              "@type": "ListItem",
              position: dayItem.day,
              name: dayTitle,
              ...(dayDesc ? { description: dayDesc } : {}),
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        if (items.length > 0) {
          itinerary = {
            "@type": "ItemList",
            numberOfItems: items.length,
            itemListElement: items,
          };
        }
      } else if (destination) {
        itinerary = {
          "@type": "Place",
          name: destination,
        };
      }

      return {
        "@type": "TouristTrip",
        "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.touristTrip}`,
        name,
        url: params.canonicalUrl,
        ...(description ? { description } : {}),
        provider: { "@id": `${params.verifiedOrigin}/${SCHEMA_ENTITY_FRAGMENTS.organization}` },
        ...(imageUrls.length > 0 ? { image: imageUrls } : {}),
        ...(durationDays !== null ? { duration: `P${durationDays}D` } : {}),
        ...(itinerary ? { itinerary } : {}),
        ...(upcomingDepartureDates.length > 0 ? { departureTime: upcomingDepartureDates } : {}),
      };
    }

    case "vehicle": {
      const bodyType =
        typeof attrs.bodyType === "string"
          ? sanitizeSeoText(attrs.bodyType, { maxLength: 40 }).toLowerCase()
          : "";
      const vehicleSchemaType = CAR_BODY_TYPES.has(bodyType) ? "Car" : "Vehicle";

      const brandName =
        typeof attrs.brand === "string" ? sanitizeSeoText(attrs.brand, { maxLength: 80 }) : "";
      const model =
        typeof attrs.model === "string" ? sanitizeSeoText(attrs.model, { maxLength: 100 }) : "";
      const variant =
        typeof attrs.variant === "string" ? sanitizeSeoText(attrs.variant, { maxLength: 100 }) : "";
      const rawYear = attrs.year ?? attrs.vehicleYear;
      const modelDate =
        typeof rawYear === "number" &&
        Number.isSafeInteger(rawYear) &&
        rawYear >= 1980 &&
        rawYear <= 2100
          ? String(rawYear)
          : null;

      const itemCondition =
        attrs.condition === "new"
          ? "https://schema.org/NewCondition"
          : attrs.condition === "used"
            ? "https://schema.org/UsedCondition"
            : null;

      // REQ-079: mileage applies to used vehicles only (never emit positive mileage for new units)
      const mileageFromOdometer =
        attrs.condition !== "new" &&
        typeof attrs.mileageKm === "number" &&
        Number.isSafeInteger(attrs.mileageKm) &&
        attrs.mileageKm >= 0
          ? {
              "@type": "QuantitativeValue",
              value: attrs.mileageKm,
              unitCode: "KMT",
            }
          : null;

      const transmission =
        typeof attrs.transmission === "string"
          ? (VEHICLE_TRANSMISSION_LABELS[attrs.transmission] ?? null)
          : null;
      const fuelType =
        typeof attrs.fuelType === "string" ? (VEHICLE_FUEL_LABELS[attrs.fuelType] ?? null) : null;
      const color =
        typeof attrs.color === "string" ? sanitizeSeoText(attrs.color, { maxLength: 60 }) : "";
      const seats =
        typeof attrs.seats === "number" && Number.isSafeInteger(attrs.seats) && attrs.seats >= 1
          ? attrs.seats
          : null;
      const engineCc =
        typeof attrs.engineCc === "number" &&
        Number.isSafeInteger(attrs.engineCc) &&
        attrs.engineCc >= 50
          ? attrs.engineCc
          : null;
      const previousOwners =
        attrs.condition === "used" &&
        typeof attrs.ownershipCount === "number" &&
        Number.isSafeInteger(attrs.ownershipCount) &&
        attrs.ownershipCount >= 1
          ? attrs.ownershipCount
          : null;

      const effectiveUnitStatus = offering.unitStatus ?? attrs.unitStatus ?? null;
      const availability = effectiveUnitStatus
        ? (VEHICLE_UNIT_AVAILABILITY[effectiveUnitStatus] ?? null)
        : null;

      // No invented Offer for on_request or inquiry; never emit financing/credit structured data (REQ-079)
      const offers = buildHonestOffer({
        priceMode: offering.priceMode,
        price: offering.price,
        priceMax: offering.priceMax,
        ctaMode: offering.ctaMode,
        canonicalUrl: params.canonicalUrl,
        availability,
      });

      return {
        "@type": vehicleSchemaType,
        "@id": `${params.canonicalUrl}${SCHEMA_ENTITY_FRAGMENTS.vehicle}`,
        name,
        url: params.canonicalUrl,
        ...(description ? { description } : {}),
        ...(imageUrls.length > 0 ? { image: imageUrls } : {}),
        ...(brandName ? { brand: { "@type": "Brand", name: brandName } } : {}),
        ...(model ? { model } : {}),
        ...(variant ? { vehicleConfiguration: variant } : {}),
        ...(modelDate ? { vehicleModelDate: modelDate } : {}),
        ...(itemCondition ? { itemCondition } : {}),
        ...(mileageFromOdometer ? { mileageFromOdometer } : {}),
        ...(transmission ? { vehicleTransmission: transmission } : {}),
        ...(fuelType ? { fuelType } : {}),
        ...(bodyType ? { bodyType } : {}),
        ...(color ? { color } : {}),
        ...(seats !== null ? { vehicleSeatingCapacity: seats } : {}),
        ...(engineCc !== null
          ? {
              vehicleEngine: {
                "@type": "EngineSpecification",
                engineDisplacement: {
                  "@type": "QuantitativeValue",
                  value: engineCc,
                  unitCode: "CMQ",
                },
              },
            }
          : {}),
        ...(previousOwners !== null ? { numberOfPreviousOwners: previousOwners } : {}),
        ...(offers ? { offers } : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization & Public Generator APIs
// ---------------------------------------------------------------------------

/**
 * Serializes a `SchemaGraphDocument` safely for `<script type="application/ld+json">`
 * using TASK-051 `safeJsonLdStringify` (neutralizes `<`, `>`, `&`, `</script>`,
 * `<!--`, `-->`, U+2028, and U+2029 while preserving valid JSON).
 */
export function serializeSchemaGraph(graph: SchemaGraphDocument): string {
  return safeJsonLdStringify(graph);
}

/**
 * Wraps a `SchemaGraphDocument` in a safe `<script type="application/ld+json">` element,
 * or returns `null` when no graph is emitted.
 */
export function renderSchemaScriptTag(graph: SchemaGraphDocument | null): string | null {
  if (!graph || graph["@graph"].length === 0) {
    return null;
  }
  return `<script type="application/ld+json">${serializeSchemaGraph(graph)}</script>`;
}

/**
 * Generates a verified, honest, safely serialized Schema.org `@graph` JSON-LD payload
 * from published visible page facts and TASK-051 SEO policy decisions.
 */
export function generateSchemaGraph(input: GenerateSchemaInput): SchemaGenerationResult {
  // 1. Evaluate authoritative SEO policy via TASK-051 (throws SeoPolicyError on malicious host/origin!)
  const seoDecision = resolvePublishedSeoDecision(input.seo);

  const basePolicy: SchemaPolicyMetadata = {
    guaranteesRichResultEligibility: false,
    guaranteesSearchRanking: false,
    disclaimer: SCHEMA_RICH_RESULT_DISCLAIMER,
    notes: [],
  };

  // 2. Suppress JSON-LD completely for draft/preview/private/error/suspended/unknown-host/redirect routes
  const suppressionReason = resolveSuppressionReason(seoDecision);
  if (suppressionReason !== null || seoDecision.canonical === null || !input.seo.tenant) {
    return {
      emitted: false,
      suppressionReason: suppressionReason ?? "missing_canonical",
      verifiedOrigin: null,
      canonicalUrl: seoDecision.canonical,
      graph: null,
      nodes: [],
      jsonLd: null,
      scriptTag: null,
      seoDecision,
      policy: basePolicy,
    };
  }

  // 3. Resolve authoritative verified primary origin (never raw Host)
  const verifiedOrigin = resolveVerifiedCanonicalOrigin(input.seo.tenant).origin;
  const canonicalUrl = seoDecision.canonical;
  const tenantId = input.tenantId?.trim() || null;
  const allowedOrigins = buildAllowedImageOrigins(verifiedOrigin, input.allowedMediaOrigins);
  const inLanguage = normalizeLanguageTag(input.locale);
  const siteName = sanitizeSeoText(input.siteName, { maxLength: 120 }) || "PunyaSitus";

  // 4. Assemble `@graph` nodes from visible published facts only
  const nodes: SchemaNode[] = [];
  const policyNotes: string[] = [];

  const orgAndBranches = buildOrganizationAndBranchNodes({
    verifiedOrigin,
    siteName,
    business: input.business,
    tenantId,
    allowedOrigins,
  });

  const websiteNode = buildWebsiteNode({
    verifiedOrigin,
    siteName,
    siteTagline: input.siteTagline,
    inLanguage,
    hasOrganizationNode: orgAndBranches.length > 0,
  });

  nodes.push(websiteNode, ...orgAndBranches);

  const breadcrumbNode = buildBreadcrumbNode(input.breadcrumbs, verifiedOrigin, canonicalUrl);

  const articleNode = input.article
    ? buildArticleNode({
        article: input.article,
        verifiedOrigin,
        canonicalUrl,
        defaultLanguage: inLanguage,
        tenantId,
        allowedOrigins,
      })
    : null;

  const offeringNode = input.offering
    ? buildOfferingNode({
        offering: input.offering,
        verifiedOrigin,
        canonicalUrl,
        tenantId,
        allowedOrigins,
        now: input.now,
        timezone: input.timezone,
      })
    : null;

  const faqNode = buildFaqNode(input.faqItems, canonicalUrl);
  if (faqNode) {
    policyNotes.push(FAQ_RICH_RESULT_NOTE);
  }

  const resolvedPageImage = resolveValidatedSchemaImage(input.pageImage, {
    tenantId,
    allowedOrigins,
  });

  const pageTitle =
    (input.pageTitle ? sanitizeSeoText(input.pageTitle, { maxLength: 200 }) : "") ||
    (input.article?.headline ? sanitizeSeoText(input.article.headline, { maxLength: 200 }) : "") ||
    (input.offering?.title ? sanitizeSeoText(input.offering.title, { maxLength: 200 }) : "") ||
    siteName;

  const pageDescription =
    input.pageDescription ??
    input.article?.description ??
    input.offering?.summary ??
    (input.seo.routeKind === "homepage" ? input.siteTagline : null);

  const mainEntityId =
    (articleNode?.["@id"] as string | undefined) ??
    (offeringNode?.["@id"] as string | undefined) ??
    (faqNode?.["@id"] as string | undefined) ??
    null;

  const webPageNode = buildWebPageNode({
    routeKind: input.seo.routeKind,
    verifiedOrigin,
    canonicalUrl,
    pageTitle,
    pageDescription,
    pageSchemaType: input.pageSchemaType ?? input.seo.resourceSeo?.schemaType ?? null,
    datePublished: input.pageDatePublished ?? input.article?.datePublished ?? null,
    dateModified: input.pageDateModified ?? input.article?.dateModified ?? null,
    primaryImage: resolvedPageImage,
    inLanguage,
    hasBreadcrumb: breadcrumbNode !== null,
    mainEntityId,
  });

  nodes.push(webPageNode);
  if (breadcrumbNode) nodes.push(breadcrumbNode);
  if (articleNode) nodes.push(articleNode);
  if (offeringNode) nodes.push(offeringNode);
  if (faqNode) nodes.push(faqNode);

  const graph: SchemaGraphDocument = {
    "@context": SCHEMA_ORG_CONTEXT,
    "@graph": nodes,
  };
  const jsonLd = serializeSchemaGraph(graph);
  const scriptTag = `<script type="application/ld+json">${jsonLd}</script>`;

  return {
    emitted: true,
    suppressionReason: null,
    verifiedOrigin,
    canonicalUrl,
    graph,
    nodes,
    jsonLd,
    scriptTag,
    seoDecision,
    policy: {
      guaranteesRichResultEligibility: false,
      guaranteesSearchRanking: false,
      disclaimer: SCHEMA_RICH_RESULT_DISCLAIMER,
      notes: policyNotes,
    },
  };
}

// ---------------------------------------------------------------------------
// High-Level Published Resource Adapter (`@punyasitus/core/content` DTOs)
// ---------------------------------------------------------------------------

export interface GeneratePublishedResourceSchemaInput extends PublishedResourceSeoInput {
  readonly tenantId?: string | null;
  readonly fallbackSiteTitle?: string;
  readonly businessProfile?: BusinessProfileSnapshot | null;
  readonly businessLogo?: SchemaImageInput | null;
  readonly businessBranches?: readonly SchemaBranchInput[] | null;
  readonly breadcrumbs?: readonly SchemaBreadcrumbItemInput[] | null;
  readonly faqItems?: readonly SchemaFaqItemInput[] | null;
  readonly primaryImage?: SchemaImageInput | null;
  readonly galleryImages?: readonly (SchemaImageInput | null | undefined)[] | null;
  readonly articleAuthorName?: string | null;
  readonly articleAuthorRoleTitle?: string | null;
  readonly articleSection?: string | null;
  readonly articleTags?: readonly string[] | null;
  readonly offeringCategoryName?: string | null;
  readonly offeringAttributes?: SchemaOfferingAttributesInput | null;
  readonly now?: Date | string | number | null;
  readonly allowedMediaOrigins?: readonly string[];
}

function mapBusinessProfileSnapshot(
  profile: BusinessProfileSnapshot | null | undefined,
  logo?: SchemaImageInput | null,
  branches?: readonly SchemaBranchInput[] | null,
): SchemaBusinessProfileInput | null {
  if (!profile) {
    return null;
  }
  return {
    businessName: profile.businessName,
    businessCategory: profile.businessCategory,
    description: profile.description ?? null,
    logo: logo ?? null,
    phone: profile.phone ?? null,
    whatsappE164: profile.whatsappE164 ?? null,
    publicEmail: profile.email ?? null,
    address: profile.address ?? null,
    city: profile.city ?? null,
    province: profile.province ?? null,
    postalCode: profile.postalCode ?? null,
    latitude: profile.latitude ?? null,
    longitude: profile.longitude ?? null,
    mapsUrl: profile.mapsUrl ?? null,
    weekdayHours: profile.weekdayHours ?? null,
    holidayHours: profile.holidayHours ?? null,
    serviceAreas: profile.serviceAreas,
    socialLinks: profile.socialLinks,
    branches: branches ?? null,
  };
}

/**
 * Convenience adapter binding `generateSchemaGraph` directly to published DTOs
 * from `@punyasitus/core/content` (`PageSnapshot`, `PostSnapshot`, `OfferingSnapshot`,
 * `SiteSettingsSnapshot`, `BusinessProfileSnapshot`).
 */
export function generatePublishedResourceSchema(
  input: GeneratePublishedResourceSchemaInput,
): SchemaGenerationResult {
  const decision = resolvePublishedResourceSeoDecision(input);
  const siteSettings: SiteSettingsSnapshot | null | undefined = input.siteSettings;
  const siteName = siteSettings?.siteTitle ?? input.fallbackSiteTitle ?? "PunyaSitus";
  const siteTagline = siteSettings?.tagline ?? null;
  const locale = siteSettings?.locale ?? SCHEMA_DEFAULT_LANGUAGE;
  const timezone = siteSettings?.timezone ?? SCHEMA_DEFAULT_TIMEZONE;
  const business = mapBusinessProfileSnapshot(
    input.businessProfile,
    input.businessLogo,
    input.businessBranches,
  );

  const resource: PublishedContentDto | null = input.resource;
  if (!resource) {
    return generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: input.requestPathname ?? "/",
        query: input.query,
        tenant: input.tenant,
        siteVisibility: siteSettings?.siteVisibility ?? "public",
        resourceState: "missing",
      },
      tenantId: input.tenantId,
      siteName,
      siteTagline,
      locale,
      timezone,
      business,
      allowedMediaOrigins: input.allowedMediaOrigins,
    });
  }

  const canonicalPath = resolvePublishedResourcePathname(resource);
  const baseRouteKind: SeoRouteKind =
    resource.resourceType === "page"
      ? resource.data.isHomepage
        ? "homepage"
        : "page"
      : resource.resourceType;
  const effectiveRouteKind: SeoRouteKind =
    decision.reason === "homepage_slug_redirect" ? "homepage_slug_alias" : baseRouteKind;

  let pageTitle: string;
  let pageDescription: string | null;
  let pageSchemaType: string | null = null;
  let article: SchemaArticleInput | null = null;
  let offering: SchemaOfferingInput | null = null;

  if (resource.resourceType === "page") {
    const page: PageSnapshot = resource.data;
    pageTitle = page.title;
    pageDescription = page.seo?.descriptionOverride ?? page.seo?.seoDescription ?? null;
    pageSchemaType = page.seo?.schemaType ?? null;
  } else if (resource.resourceType === "post") {
    const post: PostSnapshot = resource.data;
    pageTitle = post.title;
    pageDescription = post.excerpt ?? post.seo?.descriptionOverride ?? null;
    article = {
      schemaType: post.seo?.schemaType ?? "BlogPosting",
      headline: post.title,
      description: post.excerpt ?? null,
      datePublished: resource.publishedAt,
      dateModified: resource.contentModifiedAt,
      authorName: input.articleAuthorName ?? post.authorName ?? null,
      authorRoleTitle: input.articleAuthorRoleTitle ?? null,
      image: input.primaryImage ?? null,
      section: input.articleSection ?? null,
      tags: input.articleTags ?? null,
      inLanguage: locale,
    };
  } else {
    const item: OfferingSnapshot = resource.data;
    pageTitle = item.title;
    pageDescription = item.summary ?? item.seo?.descriptionOverride ?? null;
    const offeringImages: (SchemaImageInput | null | undefined)[] = [
      input.primaryImage,
      ...(input.galleryImages ?? []),
    ];
    offering = {
      offeringType: item.offeringType,
      title: item.title,
      summary: item.summary ?? null,
      priceMode: item.priceMode,
      price: item.price ?? null,
      priceMax: item.priceMax ?? null,
      negotiable: item.negotiable,
      ctaMode: item.ctaMode,
      unitStatus: item.unitStatus ?? null,
      categoryName: input.offeringCategoryName ?? null,
      images: offeringImages,
      attributes: {
        ...item.attributes,
        ...(input.offeringAttributes ?? {}),
      },
    };
  }

  return generateSchemaGraph({
    seo: {
      surface: "public_tenant",
      routeKind: effectiveRouteKind,
      pathname: input.requestPathname ?? canonicalPath,
      query: input.query,
      tenant: input.tenant,
      siteVisibility: siteSettings?.siteVisibility ?? "public",
      resourceState: decision.reason === "resource_not_published" ? "disabled" : "published",
      resourceSeo: resource.data.seo ?? null,
      canonicalOverride: input.canonicalOverride,
      redirectTargetPath: decision.reason === "homepage_slug_redirect" ? "/" : undefined,
    },
    tenantId: input.tenantId,
    siteName,
    siteTagline,
    locale,
    timezone,
    business,
    pageTitle,
    pageDescription,
    pageSchemaType,
    pageDatePublished: resource.publishedAt,
    pageDateModified: resource.contentModifiedAt,
    pageImage: input.primaryImage ?? null,
    breadcrumbs: input.breadcrumbs ?? null,
    faqItems: input.faqItems ?? null,
    article,
    offering,
    now: input.now,
    allowedMediaOrigins: input.allowedMediaOrigins,
  });
}
