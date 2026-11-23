import {
  classifySurfaceHost,
  normalizeHost,
  PLATFORM_HOSTS,
  type SurfaceKind,
} from "@punyasitus/core";
import {
  extractPublishedSnapshot,
  type OfferingSnapshot,
  type PostSnapshot,
  type PublishedResourceDto,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import {
  assertTenantR2Key,
  type MediaVariantsManifest,
} from "@punyasitus/core/media/index";
import {
  DEFAULT_MEDIA_CDN_ORIGIN,
  validateTrustedMediaOrigin,
} from "@punyasitus/core/og-generator";
import {
  buildRobotsTxtPolicy,
  escapeXmlText,
  resolvePublishedResourceSeoDecision,
  resolvePublishedSeoDecision,
  resolveVerifiedCanonicalOrigin,
  sanitizeSeoText,
  type AiTrainingPolicy,
  type SiteVisibility,
  type VerifiedCanonicalOrigin,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
import type { OfferingType } from "@punyasitus/core/schemas/common";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { getPublishedResource } from "@punyasitus/db/publication/index";
import { resolveTenantByHost } from "@punyasitus/db/routing/index";
import { CACHE_VERSION_HEADER_NAME } from "../../core/cache.ts";
import type { TenantContext } from "../../core/tenant.ts";

/**
 * Shared Tenant-Scoped Sitemap, Sub-Sitemap, Robots & Blog RSS Discovery Engine
 * (REQ-024, REQ-025, REQ-026, REQ-066, PLAN §15, TASK-017).
 *
 * Security & Isolation Invariants:
 * - Resolves tenant strictly via authoritative `PLATFORM_DB` host routing (`TASK-002`)
 *   using `request.url` ONLY — NEVER trusting `X-Forwarded-Host` or `X-Tenant-ID`.
 * - Unknown hosts, platform `app`/`console`/`marketing` hosts, and `provisioning`/`purging`/`purged`
 *   tenants NEVER receive any tenant's sitemap, sub-sitemap, or RSS feed.
 * - `suspended` and `recovery` tenants return HTTP `503` with `Cache-Control: no-store` and
 *   `X-Robots-Tag: noindex, nofollow`, NEVER cached tenant URLs.
 * - `trial` tenants and `siteVisibility === "noindex"` sites emit `Disallow: /` with NO `Sitemap:`
 *   directive on `/robots.txt` and `404` (`no-store`, `noindex, nofollow`) on `/sitemap.xml` and
 *   `/sitemaps/*.xml`.
 * - Alias hostnames 301-redirect to the tenant's verified primary canonical origin; all emitted
 *   URLs use ONLY `resolveVerifiedCanonicalOrigin` (TASK-051).
 * - Public discovery reads ONLY frozen published snapshots via `extractPublishedSnapshot` and
 *   `getPublishedResource` — draft edits, draft timestamps, unpublished/trashed rows, `noindex`
 *   content, former slugs (`is_current = 0`), paginated `?page=2+`, and faceted filters are
 *   strictly excluded.
 */

export const MAX_SITEMAP_URLS_PER_FILE = 50_000 as const;
export const MAX_SITEMAP_UNCOMPRESSED_BYTES = 50_000_000 as const;
export const MAX_RSS_FEED_ITEMS = 20 as const;
export const DISCOVERY_CACHE_MAX_AGE_SECONDS = 60 as const;

export const SITEMAP_KINDS = ["pages", "posts", "offerings"] as const;
export type SitemapKind = (typeof SITEMAP_KINDS)[number];

const OFFERING_TYPES_ORDERED: readonly OfferingType[] = [
  "service",
  "product",
  "tour",
  "vehicle",
] as const;

const OFFERING_ARCHIVE_PATH_BY_TYPE: Readonly<Record<OfferingType, string>> = {
  service: "/layanan",
  product: "/produk",
  tour: "/tour",
  vehicle: "/kendaraan",
};

const XML_CONTENT_TYPE = "application/xml; charset=utf-8" as const;
const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8" as const;
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8" as const;
const ROBOTS_DISALLOW_ALL_BODY = "User-agent: *\nDisallow: /\n" as const;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SitemapImageEntry {
  readonly loc: string;
  readonly title?: string | null;
}

export interface SitemapUrlEntry {
  readonly loc: string;
  readonly lastmod?: string | null;
  readonly images?: readonly SitemapImageEntry[];
}

export interface SitemapIndexEntry {
  readonly loc: string;
  readonly lastmod?: string | null;
}

export interface RssFeedChannelMeta {
  readonly title: string;
  readonly link: string;
  readonly feedUrl: string;
  readonly description: string;
  readonly language: string;
  readonly lastBuildDate?: string | null;
}

export interface RssFeedItemEntry {
  readonly title: string;
  readonly link: string;
  readonly guid: string;
  readonly pubDate: string;
  readonly description: string;
  readonly image?: {
    readonly url: string;
    readonly bytes?: number | null;
    readonly mimeType?: string | null;
    readonly title?: string | null;
  } | null;
}

export interface DiscoveryHandlerDeps {
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
  /** Optional ceiling override for unit/integration chunking tests (defaults to 50,000). */
  readonly maxUrlsPerSitemap?: number;
  /** Optional byte ceiling override for unit/integration chunking tests (defaults to 50 MB). */
  readonly maxBytesPerSitemap?: number;
}

interface ResolvedDiscoveryTenant {
  readonly tenant: TenantContext;
  readonly tenantDb: D1Database;
  readonly seoTenant: VerifiedTenantHostInput;
  readonly verifiedOrigin: VerifiedCanonicalOrigin;
}

type DiscoveryScopeResolution =
  | { readonly kind: "tenant"; readonly scope: ResolvedDiscoveryTenant }
  | { readonly kind: "platform_private"; readonly surface: "app" | "console"; readonly host: string }
  | { readonly kind: "platform_marketing"; readonly host: string }
  | { readonly kind: "unknown_host" }
  | { readonly kind: "alias_redirect"; readonly location: string }
  | { readonly kind: "suspended"; readonly retryAfterSeconds: number }
  | { readonly kind: "recovery"; readonly retryAfterSeconds: number }
  | { readonly kind: "destroyed" }
  | { readonly kind: "unavailable" };

interface RawPagePublishedRow {
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

interface RawPostPublishedRow {
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

interface RawOfferingPublishedRow {
  readonly id: number;
  readonly offering_type: OfferingType;
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
  readonly alt_text: string;
  readonly variants_json: string | null;
  readonly status: string;
  readonly deleted_at?: number | null;
}

interface ResolvedMediaImage {
  readonly id: number;
  readonly url: string;
  readonly alt: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly verifiedKeys: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Pure Formatting & XML Builders (Runtime-Neutral, Tested in Unit & Integration)
// ---------------------------------------------------------------------------

/**
 * Formats a positive epoch-millisecond timestamp into strict ISO-8601 UTC string.
 * Returns `null` if invalid or missing (never fabricates current time).
 */
export function formatIsoLastmod(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Formats a positive epoch-millisecond timestamp into an RFC-2822 UTC date string
 * for RSS 2.0 `<pubDate>` and `<lastBuildDate>` elements.
 */
export function formatRfc2822Date(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toUTCString() : null;
}

/**
 * Parses a sub-sitemap route parameter such as `"pages"`, `"posts"`, `"offerings"`,
 * `"pages-2"`, `"posts-3"`, etc. Returns `null` for unknown or invalid names.
 */
export function parseSubSitemapParam(rawParam: string | undefined): {
  readonly kind: SitemapKind;
  readonly chunkIndex: number;
} | null {
  if (!rawParam || typeof rawParam !== "string") return null;
  const trimmed = rawParam.trim().toLowerCase();
  const clean = trimmed.endsWith(".xml") ? trimmed.slice(0, -4) : trimmed;
  const match = /^(pages|posts|offerings)(?:-([1-9]\d*))?$/.exec(clean);
  if (!match) return null;
  const kind = match[1] as SitemapKind;
  const rawChunk = match[2];
  if (rawChunk === undefined) {
    return { kind, chunkIndex: 1 };
  }
  const chunkIndex = Number(rawChunk);
  // Chunk 1 MUST use the canonical un-suffixed path (`pages.xml`, not `pages-1.xml`)
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 2 || chunkIndex > 10_000) {
    return null;
  }
  return { kind, chunkIndex };
}

/**
 * Builds the canonical sub-sitemap path for a kind and 1-based chunk index.
 */
export function buildSubSitemapPath(kind: SitemapKind, chunkIndex = 1): string {
  return chunkIndex <= 1 ? `/sitemaps/${kind}.xml` : `/sitemaps/${kind}-${chunkIndex}.xml`;
}

/**
 * Splits a deduplicated list of sitemap URL entries into chunks that strictly respect
 * both `maxUrls` (default 50,000) and `maxBytes` (default 50 MB uncompressed) per PLAN §15.5.
 */
export function chunkSitemapUrlEntries(
  entries: readonly SitemapUrlEntry[],
  options?: { readonly maxUrls?: number; readonly maxBytes?: number },
): readonly (readonly SitemapUrlEntry[])[] {
  const maxUrls = Math.max(
    1,
    Math.min(MAX_SITEMAP_URLS_PER_FILE, Math.floor(options?.maxUrls ?? MAX_SITEMAP_URLS_PER_FILE)),
  );
  const maxBytes = Math.max(
    512,
    Math.min(
      MAX_SITEMAP_UNCOMPRESSED_BYTES,
      Math.floor(options?.maxBytes ?? MAX_SITEMAP_UNCOMPRESSED_BYTES),
    ),
  );

  // Deduplicate by exact `<loc>` preserving first-seen order
  const seen = new Set<string>();
  const unique: SitemapUrlEntry[] = [];
  for (const entry of entries) {
    if (!entry.loc || seen.has(entry.loc)) continue;
    seen.add(entry.loc);
    unique.push(entry);
  }

  if (unique.length === 0) {
    return [[]];
  }

  const encoder = new TextEncoder();
  const wrapperOverheadBytes = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
      "</urlset>\n",
  ).byteLength;

  const chunks: SitemapUrlEntry[][] = [];
  let current: SitemapUrlEntry[] = [];
  let currentBytes = wrapperOverheadBytes;

  for (const entry of unique) {
    const entryXml = renderUrlEntryXml(entry);
    const entryBytes = encoder.encode(entryXml).byteLength;

    if (
      current.length > 0 &&
      (current.length >= maxUrls || currentBytes + entryBytes > maxBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = wrapperOverheadBytes;
    }

    current.push(entry);
    currentBytes += entryBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function renderUrlEntryXml(entry: SitemapUrlEntry): string {
  const lines: string[] = ["  <url>", `    <loc>${escapeXmlText(entry.loc)}</loc>`];
  if (entry.lastmod) {
    lines.push(`    <lastmod>${escapeXmlText(entry.lastmod)}</lastmod>`);
  }
  if (entry.images && entry.images.length > 0) {
    const seenImg = new Set<string>();
    for (const img of entry.images) {
      if (!img.loc || seenImg.has(img.loc)) continue;
      seenImg.add(img.loc);
      lines.push("    <image:image>");
      lines.push(`      <image:loc>${escapeXmlText(img.loc)}</image:loc>`);
      const cleanTitle = img.title ? sanitizeSeoText(img.title, { maxLength: 200 }) : "";
      if (cleanTitle) {
        lines.push(`      <image:title>${escapeXmlText(cleanTitle)}</image:title>`);
      }
      lines.push("    </image:image>");
    }
  }
  lines.push("  </url>");
  return `${lines.join("\n")}\n`;
}

/**
 * Generates a valid XML Sitemap Index (`<sitemapindex>`) document.
 */
export function buildSitemapIndexXml(entries: readonly SitemapIndexEntry[]): string {
  const seen = new Set<string>();
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const entry of entries) {
    if (!entry.loc || seen.has(entry.loc)) continue;
    seen.add(entry.loc);
    parts.push("  <sitemap>");
    parts.push(`    <loc>${escapeXmlText(entry.loc)}</loc>`);
    if (entry.lastmod) {
      parts.push(`    <lastmod>${escapeXmlText(entry.lastmod)}</lastmod>`);
    }
    parts.push("  </sitemap>");
  }

  parts.push("</sitemapindex>");
  return `${parts.join("\n")}\n`;
}

/**
 * Generates a valid XML Sitemap (`<urlset>`) with Google Image Sitemap namespace (`xmlns:image`).
 */
export function buildUrlsetXml(entries: readonly SitemapUrlEntry[]): string {
  const seen = new Set<string>();
  let body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';

  for (const entry of entries) {
    if (!entry.loc || seen.has(entry.loc)) continue;
    seen.add(entry.loc);
    body += renderUrlEntryXml(entry);
  }

  body += "</urlset>\n";
  return body;
}

/**
 * Generates a valid RSS 2.0 XML document for `/blog/feed.xml` (PLAN §15.7).
 */
export function buildBlogRssFeedXml(
  channel: RssFeedChannelMeta,
  items: readonly RssFeedItemEntry[],
): string {
  const capped = items.slice(0, MAX_RSS_FEED_ITEMS);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">',
    "  <channel>",
    `    <title>${escapeXmlText(channel.title)}</title>`,
    `    <link>${escapeXmlText(channel.link)}</link>`,
    `    <description>${escapeXmlText(channel.description)}</description>`,
    `    <language>${escapeXmlText(channel.language)}</language>`,
  ];

  if (channel.lastBuildDate) {
    lines.push(`    <lastBuildDate>${escapeXmlText(channel.lastBuildDate)}</lastBuildDate>`);
  }
  lines.push(
    `    <atom:link href="${escapeXmlText(channel.feedUrl)}" rel="self" type="application/rss+xml" />`,
  );

  for (const item of capped) {
    lines.push("    <item>");
    lines.push(`      <title>${escapeXmlText(item.title)}</title>`);
    lines.push(`      <link>${escapeXmlText(item.link)}</link>`);
    lines.push(`      <guid isPermaLink="true">${escapeXmlText(item.guid)}</guid>`);
    lines.push(`      <pubDate>${escapeXmlText(item.pubDate)}</pubDate>`);
    lines.push(`      <description>${escapeXmlText(item.description)}</description>`);
    if (item.image && item.image.url) {
      const mime = item.image.mimeType?.trim() || "image/webp";
      const length =
        typeof item.image.bytes === "number" && Number.isFinite(item.image.bytes) && item.image.bytes > 0
          ? Math.floor(item.image.bytes)
          : 0;
      lines.push(
        `      <enclosure url="${escapeXmlText(item.image.url)}" length="${length}" type="${escapeXmlText(mime)}" />`,
      );
      lines.push(
        `      <media:content url="${escapeXmlText(item.image.url)}" medium="image" type="${escapeXmlText(mime)}" />`,
      );
    }
    lines.push("    </item>");
  }

  lines.push("  </channel>");
  lines.push("</rss>");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Response Helpers
// ---------------------------------------------------------------------------

function createResponse(
  request: Request,
  body: string | null,
  status: number,
  headers: HeadersInit,
): Response {
  const isHead = request.method.toUpperCase() === "HEAD";
  return new Response(isHead ? null : body, { status, headers });
}

function createNotFoundResponse(request: Request, contentType: string = TEXT_CONTENT_TYPE): Response {
  return createResponse(request, "", 404, {
    "Content-Type": contentType,
    ...NO_STORE_HEADERS,
  });
}

function createUnavailableResponse(
  request: Request,
  retryAfterSeconds: number,
  options?: { readonly body?: string; readonly contentType?: string },
): Response {
  return createResponse(request, options?.body ?? "", 503, {
    "Content-Type": options?.contentType ?? TEXT_CONTENT_TYPE,
    "Retry-After": String(retryAfterSeconds),
    ...NO_STORE_HEADERS,
  });
}

function createAliasRedirectResponse(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

export function createMethodNotAllowedResponse(request: Request): Response {
  return createResponse(request, "", 405, {
    "Content-Type": TEXT_CONTENT_TYPE,
    Allow: "GET, HEAD",
    ...NO_STORE_HEADERS,
  });
}

function buildPublicDiscoveryHeaders(params: {
  readonly contentType: string;
  readonly tenantId: string;
  readonly cacheVersion: number;
  readonly resourceKey: string;
  readonly noStore?: boolean;
  readonly xRobotsTag?: string | null;
}): Headers {
  const headers = new Headers({
    "Content-Type": params.contentType,
    Vary: "Accept-Encoding",
    [CACHE_VERSION_HEADER_NAME]: String(params.cacheVersion),
  });

  if (params.noStore) {
    headers.set("Cache-Control", "no-store");
  } else {
    headers.set(
      "Cache-Control",
      `public, max-age=${DISCOVERY_CACHE_MAX_AGE_SECONDS}, s-maxage=${DISCOVERY_CACHE_MAX_AGE_SECONDS}`,
    );
    headers.set(
      "ETag",
      `W/"t-${params.tenantId}-v${params.cacheVersion}-${params.resourceKey}"`,
    );
  }

  if (params.xRobotsTag) {
    headers.set("X-Robots-Tag", params.xRobotsTag);
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Host-Scoped Tenant Resolution (Strict TASK-002 + TASK-051 Integration)
// ---------------------------------------------------------------------------

function buildSeoTenantInput(tenant: TenantContext): VerifiedTenantHostInput {
  const verifiedHosts = new Set<string>();
  verifiedHosts.add(tenant.host);
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

async function resolveDiscoveryTenantScope(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<DiscoveryScopeResolution> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: "unknown_host" };
  }

  // Strictly extract host from `request.url` (NEVER trust X-Forwarded-Host or X-Tenant-ID!)
  const normalizedUrlHost = normalizeHost(url.hostname);
  const platformDomain = deps.platformDomain ?? PLATFORM_HOSTS.marketing;

  // 1. Platform surface isolation check (both via pre-resolved locals.surface AND direct URL host)
  if (deps.surface === "app" || deps.surface === "console") {
    return {
      kind: "platform_private",
      surface: deps.surface,
      host: deps.host ?? normalizedUrlHost ?? "",
    };
  }
  if (deps.surface === "marketing") {
    return {
      kind: "platform_marketing",
      host: deps.host ?? normalizedUrlHost ?? platformDomain,
    };
  }
  if (deps.surface === "unknown") {
    return { kind: "unknown_host" };
  }

  if (normalizedUrlHost) {
    const platformSurface = classifyPlatformSurfaceFromHost(normalizedUrlHost, platformDomain);
    if (platformSurface === "app" || platformSurface === "console") {
      return { kind: "platform_private", surface: platformSurface, host: normalizedUrlHost };
    }
    if (platformSurface === "marketing") {
      return { kind: "platform_marketing", host: normalizedUrlHost };
    }
  }

  // 2. Obtain authoritative TenantContext (either from verified middleware locals OR live PLATFORM_DB lookup)
  let tenant: TenantContext | null = deps.tenant ?? null;
  let tenantDb: D1Database | null = deps.tenantDb ?? null;

  if (!tenant) {
    if (!normalizedUrlHost || !deps.platformDb) {
      return { kind: "unknown_host" };
    }
    const resolution = await resolveTenantByHost(deps.platformDb, normalizedUrlHost, {
      nowMs: deps.nowMs,
      bypassCache: deps.bypassHostCache,
    });
    if (resolution.kind === "db_unavailable") {
      return { kind: "unavailable" };
    }
    if (resolution.kind !== "resolved") {
      return { kind: "unknown_host" };
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

  // 3. Tenant lifecycle gates (PLAN §15.2 & §17.1)
  const effectiveStatus = tenant.operatorHold ? "suspended" : tenant.status;
  if (
    effectiveStatus === "provisioning" ||
    effectiveStatus === "purging" ||
    effectiveStatus === "purged"
  ) {
    return { kind: "destroyed" };
  }
  if (effectiveStatus === "suspended") {
    return { kind: "suspended", retryAfterSeconds: 3600 };
  }
  if (effectiveStatus === "recovery") {
    return { kind: "recovery", retryAfterSeconds: 60 };
  }

  // 4. Verified primary canonical origin resolution via TASK-051 (fail closed on malicious/foreign hosts)
  const seoTenant = buildSeoTenantInput(tenant);
  let verifiedOrigin: VerifiedCanonicalOrigin;
  try {
    verifiedOrigin = resolveVerifiedCanonicalOrigin(seoTenant);
  } catch {
    return { kind: "unknown_host" };
  }

  // 5. Verified alias host -> 301 redirect to primary canonical origin (never serve alias sitemap copies)
  if (verifiedOrigin.isAliasRequest) {
    return {
      kind: "alias_redirect",
      location: `${verifiedOrigin.origin}${url.pathname}`,
    };
  }

  // 6. Bind tenant DO SQLite DB if not already provided by middleware
  if (!tenantDb && deps.tenantStore) {
    try {
      const stub = openTenantStoreStub(deps.tenantStore, tenant.id);
      tenantDb = createTenantDb(stub);
    } catch {
      return { kind: "unavailable" };
    }
  }
  if (!tenantDb) {
    return { kind: "unavailable" };
  }

  return {
    kind: "tenant",
    scope: {
      tenant,
      tenantDb,
      seoTenant,
      verifiedOrigin,
    },
  };
}

// ---------------------------------------------------------------------------
// Published Tenant Data & Media Loaders (Zero Draft Leaks, Bounded Queries)
// ---------------------------------------------------------------------------

async function loadPublishedSiteSettings(
  tenantDb: D1Database,
): Promise<SiteSettingsSnapshot | null> {
  try {
    const dto = await getPublishedResource(tenantDb, {
      resourceType: "site_settings",
      resourceId: 1,
    });
    return dto?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Checks `installed_plugins` for `seo-ai-autopilot` (`REQ-066`).
 * Default when no row exists is active (`true`); an explicit row with `enabled = 0` disables sitemaps.
 */
async function isSeoAutopilotActive(tenantDb: D1Database): Promise<boolean> {
  try {
    const row = await tenantDb
      .prepare("SELECT enabled FROM installed_plugins WHERE plugin_id = 'seo-ai-autopilot' LIMIT 1")
      .first<{ readonly enabled: number }>();
    if (!row) return true;
    return Number(row.enabled) !== 0;
  } catch {
    return true;
  }
}

function resolveMediaBaseOrigin(mediaPublicBaseUrl?: string | null): string {
  if (mediaPublicBaseUrl) {
    const validated = validateTrustedMediaOrigin(mediaPublicBaseUrl);
    if (validated) return validated;
  }
  return DEFAULT_MEDIA_CDN_ORIGIN;
}

function parseVariantsManifest(raw: string | null): MediaVariantsManifest | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MediaVariantsManifest>;
    if (parsed && typeof parsed === "object") {
      return parsed as MediaVariantsManifest;
    }
    return null;
  } catch {
    return null;
  }
}

const SQL_IN_BATCH_SIZE = 80 as const;

function mapVerifiedReadyMediaRow(
  tenantId: string,
  row: RawMediaRow,
  mediaBaseOrigin: string,
): ResolvedMediaImage | null {
  if (row.kind !== "image") return null;
  if (row.status !== "ready") return null;
  if (row.deleted_at !== undefined && row.deleted_at !== null) return null;

  const variants = parseVariantsManifest(row.variants_json);
  const preferredEntry = variants?.w1280 ?? variants?.master ?? variants?.og ?? null;
  const candidateKey = preferredEntry?.key ?? row.r2_key;
  if (!candidateKey || typeof candidateKey !== "string") return null;

  let primaryVerifiedKey: string;
  try {
    primaryVerifiedKey = assertTenantR2Key(tenantId, candidateKey, ["media"]);
  } catch {
    return null;
  }

  const verifiedKeys = new Set<string>([primaryVerifiedKey]);
  const allCandidateKeys = [
    row.r2_key,
    variants?.master?.key,
    variants?.w1280?.key,
    variants?.w640?.key,
    variants?.thumb?.key,
    variants?.og?.key,
  ];
  for (const key of allCandidateKeys) {
    if (typeof key !== "string" || !key) continue;
    try {
      verifiedKeys.add(assertTenantR2Key(tenantId, key, ["media"]));
    } catch {
      // Ignore non-media / invalid keys
    }
  }

  const normalizedPath = primaryVerifiedKey.replace(/^\/+/, "");
  return {
    id: Number(row.id),
    url: `${mediaBaseOrigin}/${normalizedPath}`,
    alt: sanitizeSeoText(row.alt_text ?? "", { maxLength: 200 }),
    bytes: preferredEntry?.bytes ?? Number(row.bytes ?? 0),
    mimeType: preferredEntry?.mimeType ?? (row.mime_type || "image/webp"),
    verifiedKeys,
  };
}

/**
 * Batch-resolves tenant-owned `ready` image rows from `TenantStore.media_items`
 * into verified public HTTPS URLs + alt text.
 * Rejects non-image, non-ready, trashed, quarantine, trash, or cross-tenant R2 keys.
 */
async function loadVerifiedTenantImagesById(
  tenantId: string,
  tenantDb: D1Database,
  mediaIds: ReadonlySet<number>,
  mediaBaseOrigin: string,
): Promise<Map<number, ResolvedMediaImage>> {
  const result = new Map<number, ResolvedMediaImage>();
  if (mediaIds.size === 0) return result;

  const ids = Array.from(mediaIds).filter(
    (id) => Number.isSafeInteger(id) && id >= 1 && id <= 2_147_483_647,
  );

  for (let i = 0; i < ids.length; i += SQL_IN_BATCH_SIZE) {
    const batch = ids.slice(i, i + SQL_IN_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const queryRes = await tenantDb
      .prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`)
      .bind(...batch)
      .all<RawMediaRow>();

    for (const row of queryRes.results) {
      const mapped = mapVerifiedReadyMediaRow(tenantId, row, mediaBaseOrigin);
      if (mapped) {
        result.set(mapped.id, mapped);
      }
    }
  }

  return result;
}

/**
 * Batch-resolves tenant-owned `ready` image rows by exact `r2_key` for inline section
 * URLs that do not embed a sequential numeric `mediaId` segment.
 */
async function loadVerifiedTenantImagesByR2Key(
  tenantId: string,
  tenantDb: D1Database,
  r2Keys: ReadonlySet<string>,
  mediaBaseOrigin: string,
): Promise<Map<string, ResolvedMediaImage>> {
  const result = new Map<string, ResolvedMediaImage>();
  if (r2Keys.size === 0) return result;

  const keys = Array.from(r2Keys);
  for (let i = 0; i < keys.length; i += SQL_IN_BATCH_SIZE) {
    const batch = keys.slice(i, i + SQL_IN_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const queryRes = await tenantDb
      .prepare(`SELECT * FROM media_items WHERE r2_key IN (${placeholders})`)
      .bind(...batch)
      .all<RawMediaRow>();

    for (const row of queryRes.results) {
      const mapped = mapVerifiedReadyMediaRow(tenantId, row, mediaBaseOrigin);
      if (!mapped) continue;
      for (const verifiedKey of mapped.verifiedKeys) {
        result.set(verifiedKey, mapped);
      }
    }
  }

  return result;
}

export interface ParsedInlineSectionImage {
  readonly url: string;
  readonly r2Key: string;
  readonly mediaId: number | null;
}

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
 * Strictly validates an inline section image URL against the trusted media CDN origin
 * and THIS tenant's `/t/<tenantId>/media/...` namespace.
 *
 * Rejects:
 * - Any `%` percent-encoding (blocks `/%74/<otherTenant>/media/...`, `%2e`, `%2f`, etc.)
 * - Control chars, whitespace, `\`, `<`, `>`, `"`, `'`, `?` query, `#` fragment
 * - Non-`https://` schemes, embedded credentials, explicit ports, or non-media-CDN origins
 * - Missing `/t/<tenantId>/media/` prefix, dot-segment traversal (`..`), or `assertTenantR2Key` failure
 */
export function parseInlineSectionImageUrl(
  rawUrl: string,
  tenantId: string,
  mediaBaseOrigin: string = DEFAULT_MEDIA_CDN_ORIGIN,
): ParsedInlineSectionImage | null {
  if (typeof rawUrl !== "string" || !tenantId || hasAsciiControlChars(rawUrl)) {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || !/^https:\/\//i.test(trimmed)) {
    return null;
  }
  // Reject percent-encoding, backslashes, quotes, angle brackets, whitespace, query, and fragments
  if (/[%\\<>"'\s?#]/.test(trimmed)) {
    return null;
  }

  // Inspect raw authority before WHATWG URL parsing can normalize credentials/ports/traversal
  const afterScheme = trimmed.slice(8);
  const slashIdx = afterScheme.indexOf("/");
  if (slashIdx <= 0) {
    return null;
  }
  const rawAuthority = afterScheme.slice(0, slashIdx);
  const rawPath = afterScheme.slice(slashIdx);
  if (rawAuthority.includes("@") || rawAuthority.includes(":")) {
    return null;
  }
  if (rawPath.includes("//") || rawPath.includes("..")) {
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
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }

  const expectedOrigin = resolveMediaBaseOrigin(mediaBaseOrigin);
  const origin = validateTrustedMediaOrigin(`https://${parsed.hostname}`);
  if (!origin || origin !== expectedOrigin) {
    return null;
  }

  // Require exact tenant media namespace prefix `/t/<tenantId>/media/`
  const requiredPrefix = `/t/${tenantId}/media/`;
  if (!rawPath.startsWith(requiredPrefix) || parsed.pathname !== rawPath) {
    return null;
  }

  const candidateKey = parsed.pathname.slice(1);
  let verifiedKey: string;
  try {
    verifiedKey = assertTenantR2Key(tenantId, candidateKey, ["media"]);
  } catch {
    return null;
  }

  // Extract sequential numeric media ID when key follows `t/<tenantId>/media/<mediaId>/<file>`
  const afterMediaPrefix = verifiedKey.slice(`t/${tenantId}/media/`.length);
  const idMatch = /^([1-9]\d*)\/[^/]+$/.exec(afterMediaPrefix);
  const parsedId = idMatch ? Number(idMatch[1]) : null;
  const mediaId =
    parsedId !== null && Number.isSafeInteger(parsedId) && parsedId <= 2_147_483_647
      ? parsedId
      : null;

  return {
    url: `${origin}/${verifiedKey}`,
    r2Key: verifiedKey,
    mediaId,
  };
}

export function validateInlineSectionImageUrl(
  rawUrl: string,
  tenantId: string,
  mediaBaseOrigin: string = DEFAULT_MEDIA_CDN_ORIGIN,
): string | null {
  return parseInlineSectionImageUrl(rawUrl, tenantId, mediaBaseOrigin)?.url ?? null;
}

function collectPostImageMediaIds(post: PostSnapshot): number[] {
  const ids: number[] = [];
  if (post.coverMediaId) ids.push(post.coverMediaId);
  if (post.seo?.ogImageMediaId) ids.push(post.seo.ogImageMediaId);
  for (const block of post.body.blocks) {
    if (block.type === "image" && block.mediaId !== undefined) {
      ids.push(block.mediaId);
    }
  }
  return ids;
}

function collectOfferingImageMediaIds(offering: OfferingSnapshot): number[] {
  const ids: number[] = [];
  if (offering.coverMediaId) ids.push(offering.coverMediaId);
  for (const gid of offering.galleryMediaIds) {
    ids.push(gid);
  }
  if (offering.seo?.ogImageMediaId) ids.push(offering.seo.ogImageMediaId);
  if (
    offering.description &&
    typeof offering.description === "object" &&
    "blocks" in offering.description &&
    Array.isArray(offering.description.blocks)
  ) {
    for (const block of offering.description.blocks) {
      if (block.type === "image" && block.mediaId !== undefined) {
        ids.push(block.mediaId);
      }
    }
  }
  return ids;
}

function getEffectiveLastmodMs(
  dto: Pick<PublishedResourceDto<"page" | "post" | "offering">, "publishedAt" | "contentModifiedAt">,
): number | null {
  if (typeof dto.contentModifiedAt === "number" && dto.contentModifiedAt > 0) {
    return dto.contentModifiedAt;
  }
  if (typeof dto.publishedAt === "number" && dto.publishedAt > 0) {
    return dto.publishedAt;
  }
  return null;
}

function maxTimestampMs(values: readonly (number | null)[]): number | null {
  let max: number | null = null;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      if (max === null || v > max) {
        max = v;
      }
    }
  }
  return max;
}

/**
 * Loads all sitemap-eligible published pages for the scoped tenant.
 * Strictly reads published snapshots ONLY; excludes drafts, trashed, unpublished,
 * `noindex` overrides, non-self canonicals, and former slugs.
 */
async function collectPublishedPageSitemapEntries(params: {
  readonly scope: ResolvedDiscoveryTenant;
  readonly siteSettings: SiteSettingsSnapshot | null;
  readonly mediaBaseOrigin: string;
}): Promise<SitemapUrlEntry[]> {
  const res = await params.scope.tenantDb
    .prepare(
      `SELECT id, slug, title, is_homepage, published_sections_json, seo_json,
              status, published_at, content_modified_at, deleted_at, version, updated_at
       FROM pages
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND published_sections_json IS NOT NULL
       ORDER BY is_homepage DESC, id ASC
       LIMIT ?`,
    )
    .bind(MAX_SITEMAP_URLS_PER_FILE)
    .all<RawPagePublishedRow>();

  const eligible: Array<{
    readonly dto: PublishedResourceDto<"page">;
    readonly canonical: string;
    readonly lastmodMs: number | null;
    readonly mediaIds: readonly number[];
    readonly parsedSectionImages: ReadonlyArray<{
      readonly parsed: ParsedInlineSectionImage;
      readonly alt: string;
    }>;
  }> = [];
  const allMediaIds = new Set<number>();
  const allSectionR2Keys = new Set<string>();

  for (const row of res.results) {
    let dto: PublishedResourceDto<"page"> | null;
    try {
      dto = extractPublishedSnapshot("page", {
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
      continue;
    }
    if (!dto) continue;

    const decision = resolvePublishedResourceSeoDecision({
      tenant: params.scope.seoTenant,
      siteSettings: params.siteSettings,
      resource: dto,
      canonicalOverride: dto.data.seo?.canonicalOverride ?? null,
    });

    if (!decision.sitemapEligible || !decision.canonical) continue;

    const pageMediaIds: number[] = [];
    if (dto.data.seo?.ogImageMediaId) {
      pageMediaIds.push(dto.data.seo.ogImageMediaId);
      allMediaIds.add(dto.data.seo.ogImageMediaId);
    }

    const parsedSectionImages: Array<{
      readonly parsed: ParsedInlineSectionImage;
      readonly alt: string;
    }> = [];
    for (const section of dto.data.sections) {
      if (!section.media) continue;
      for (const asset of section.media) {
        const parsedImg = parseInlineSectionImageUrl(
          asset.url,
          params.scope.tenant.id,
          params.mediaBaseOrigin,
        );
        if (!parsedImg) continue;
        parsedSectionImages.push({ parsed: parsedImg, alt: asset.alt });
        if (parsedImg.mediaId !== null) {
          allMediaIds.add(parsedImg.mediaId);
        }
        allSectionR2Keys.add(parsedImg.r2Key);
      }
    }

    eligible.push({
      dto,
      canonical: decision.canonical,
      lastmodMs: getEffectiveLastmodMs(dto),
      mediaIds: pageMediaIds,
      parsedSectionImages,
    });
  }

  const [resolvedMedia, resolvedMediaByKey] = await Promise.all([
    loadVerifiedTenantImagesById(
      params.scope.tenant.id,
      params.scope.tenantDb,
      allMediaIds,
      params.mediaBaseOrigin,
    ),
    loadVerifiedTenantImagesByR2Key(
      params.scope.tenant.id,
      params.scope.tenantDb,
      allSectionR2Keys,
      params.mediaBaseOrigin,
    ),
  ]);

  const entries: SitemapUrlEntry[] = [];
  const seenLocs = new Set<string>();

  for (const item of eligible) {
    if (seenLocs.has(item.canonical)) continue;
    seenLocs.add(item.canonical);

    const images: SitemapImageEntry[] = [];
    const seenImg = new Set<string>();

    // In-content section images MUST match a verified `ready` `media_items` row in THIS tenant
    for (const { parsed, alt } of item.parsedSectionImages) {
      const matchedMedia =
        (parsed.mediaId !== null ? resolvedMedia.get(parsed.mediaId) : undefined) ??
        resolvedMediaByKey.get(parsed.r2Key);
      if (!matchedMedia || !matchedMedia.verifiedKeys.has(parsed.r2Key)) {
        continue;
      }
      if (seenImg.has(parsed.url)) continue;
      seenImg.add(parsed.url);
      images.push({
        loc: parsed.url,
        title: alt || matchedMedia.alt || item.dto.data.title,
      });
    }

    // Referenced ready media items (e.g., OG/featured image)
    for (const mid of item.mediaIds) {
      const media = resolvedMedia.get(mid);
      if (!media || seenImg.has(media.url)) continue;
      seenImg.add(media.url);
      images.push({
        loc: media.url,
        title: media.alt || item.dto.data.title,
      });
    }

    entries.push({
      loc: item.canonical,
      lastmod: formatIsoLastmod(item.lastmodMs),
      images,
    });
  }

  return entries;
}

/**
 * Loads all sitemap-eligible published blog posts (plus `/blog` archive first page when non-empty)
 * for the scoped tenant. Returns `[]` when `blogEnabled === false`.
 */
async function collectPublishedPostSitemapEntries(params: {
  readonly scope: ResolvedDiscoveryTenant;
  readonly siteSettings: SiteSettingsSnapshot | null;
  readonly mediaBaseOrigin: string;
}): Promise<SitemapUrlEntry[]> {
  if (params.siteSettings?.blogEnabled === false) {
    return [];
  }

  const res = await params.scope.tenantDb
    .prepare(
      `SELECT id, slug, title, excerpt, published_body_json, primary_category_id,
              author_id, cover_media_id, reading_time_minutes, show_toc, seo_json,
              status, published_at, content_modified_at, deleted_at, version, updated_at
       FROM posts
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND published_body_json IS NOT NULL
       ORDER BY published_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(MAX_SITEMAP_URLS_PER_FILE)
    .all<RawPostPublishedRow>();

  const eligible: Array<{
    readonly dto: PublishedResourceDto<"post">;
    readonly canonical: string;
    readonly lastmodMs: number | null;
    readonly mediaIds: readonly number[];
  }> = [];
  const allMediaIds = new Set<number>();

  for (const row of res.results) {
    let dto: PublishedResourceDto<"post"> | null;
    try {
      dto = extractPublishedSnapshot("post", {
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
      continue;
    }
    if (!dto) continue;

    const decision = resolvePublishedResourceSeoDecision({
      tenant: params.scope.seoTenant,
      siteSettings: params.siteSettings,
      resource: dto,
      canonicalOverride: dto.data.seo?.canonicalOverride ?? null,
    });

    if (!decision.sitemapEligible || !decision.canonical) continue;

    const mediaIds = collectPostImageMediaIds(dto.data);
    for (const mid of mediaIds) allMediaIds.add(mid);

    eligible.push({
      dto,
      canonical: decision.canonical,
      lastmodMs: getEffectiveLastmodMs(dto),
      mediaIds,
    });
  }

  if (eligible.length === 0) {
    return [];
  }

  const resolvedMedia = await loadVerifiedTenantImagesById(
    params.scope.tenant.id,
    params.scope.tenantDb,
    allMediaIds,
    params.mediaBaseOrigin,
  );

  const entries: SitemapUrlEntry[] = [];
  const seenLocs = new Set<string>();

  // Eligible non-empty `/blog` archive first page (PLAN §15.2 & §15.5)
  const siteVisibility: SiteVisibility = params.siteSettings?.siteVisibility ?? "public";
  const blogArchiveDecision = resolvePublishedSeoDecision({
    surface: "public_tenant",
    routeKind: "blog_index",
    pathname: "/blog",
    tenant: params.scope.seoTenant,
    siteVisibility,
    archiveEnabled: params.siteSettings?.blogEnabled ?? true,
    publishedItemCount: eligible.length,
  });

  if (blogArchiveDecision.sitemapEligible && blogArchiveDecision.canonical) {
    seenLocs.add(blogArchiveDecision.canonical);
    entries.push({
      loc: blogArchiveDecision.canonical,
      lastmod: formatIsoLastmod(maxTimestampMs(eligible.map((e) => e.lastmodMs))),
    });
  }

  for (const item of eligible) {
    if (seenLocs.has(item.canonical)) continue;
    seenLocs.add(item.canonical);

    const images: SitemapImageEntry[] = [];
    const seenImg = new Set<string>();
    for (const mid of item.mediaIds) {
      const media = resolvedMedia.get(mid);
      if (!media || seenImg.has(media.url)) continue;
      seenImg.add(media.url);
      images.push({
        loc: media.url,
        title: media.alt || item.dto.data.title,
      });
    }

    entries.push({
      loc: item.canonical,
      lastmod: formatIsoLastmod(item.lastmodMs),
      images,
    });
  }

  return entries;
}

/**
 * Loads all sitemap-eligible published offerings (`service`, `product`, `tour`, `vehicle`)
 * plus eligible non-empty catalog index first pages (`/layanan`, `/produk`, `/tour`, `/kendaraan`).
 * Returns `[]` when `catalogEnabled === false`.
 */
async function collectPublishedOfferingSitemapEntries(params: {
  readonly scope: ResolvedDiscoveryTenant;
  readonly siteSettings: SiteSettingsSnapshot | null;
  readonly mediaBaseOrigin: string;
}): Promise<SitemapUrlEntry[]> {
  if (params.siteSettings?.catalogEnabled === false) {
    return [];
  }

  const res = await params.scope.tenantDb
    .prepare(
      `SELECT id, offering_type, slug, title, summary, description, cover_media_id,
              gallery_media_ids_json, video_media_id, youtube_video_id, price_mode,
              price, price_max, negotiable, original_amount, badge, cta_mode,
              external_url, unit_status, attributes_version, attributes_json,
              published_snapshot_json, seo_json, status, published_at,
              content_modified_at, deleted_at, version, updated_at
       FROM offerings
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND published_snapshot_json IS NOT NULL
       ORDER BY offering_type ASC, id ASC
       LIMIT ?`,
    )
    .bind(MAX_SITEMAP_URLS_PER_FILE)
    .all<RawOfferingPublishedRow>();

  const eligible: Array<{
    readonly dto: PublishedResourceDto<"offering">;
    readonly canonical: string;
    readonly lastmodMs: number | null;
    readonly mediaIds: readonly number[];
  }> = [];
  const allMediaIds = new Set<number>();

  for (const row of res.results) {
    let dto: PublishedResourceDto<"offering"> | null;
    try {
      dto = extractPublishedSnapshot("offering", {
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
      continue;
    }
    if (!dto) continue;

    const decision = resolvePublishedResourceSeoDecision({
      tenant: params.scope.seoTenant,
      siteSettings: params.siteSettings,
      resource: dto,
    });

    if (!decision.sitemapEligible || !decision.canonical) continue;

    const mediaIds = collectOfferingImageMediaIds(dto.data);
    for (const mid of mediaIds) allMediaIds.add(mid);

    eligible.push({
      dto,
      canonical: decision.canonical,
      lastmodMs: getEffectiveLastmodMs(dto),
      mediaIds,
    });
  }

  if (eligible.length === 0) {
    return [];
  }

  const resolvedMedia = await loadVerifiedTenantImagesById(
    params.scope.tenant.id,
    params.scope.tenantDb,
    allMediaIds,
    params.mediaBaseOrigin,
  );

  const entries: SitemapUrlEntry[] = [];
  const seenLocs = new Set<string>();
  const siteVisibility: SiteVisibility = params.siteSettings?.siteVisibility ?? "public";

  // Eligible non-empty catalog index first pages per offering type (never `?page=2` or faceted filters)
  for (const offeringType of OFFERING_TYPES_ORDERED) {
    const itemsOfType = eligible.filter((item) => item.dto.data.offeringType === offeringType);
    if (itemsOfType.length === 0) continue;

    const archiveDecision = resolvePublishedSeoDecision({
      surface: "public_tenant",
      routeKind: "catalog_index",
      pathname: OFFERING_ARCHIVE_PATH_BY_TYPE[offeringType],
      tenant: params.scope.seoTenant,
      siteVisibility,
      archiveEnabled: params.siteSettings?.catalogEnabled ?? true,
      publishedItemCount: itemsOfType.length,
    });

    if (archiveDecision.sitemapEligible && archiveDecision.canonical) {
      if (!seenLocs.has(archiveDecision.canonical)) {
        seenLocs.add(archiveDecision.canonical);
        entries.push({
          loc: archiveDecision.canonical,
          lastmod: formatIsoLastmod(maxTimestampMs(itemsOfType.map((e) => e.lastmodMs))),
        });
      }
    }
  }

  for (const item of eligible) {
    if (seenLocs.has(item.canonical)) continue;
    seenLocs.add(item.canonical);

    const images: SitemapImageEntry[] = [];
    const seenImg = new Set<string>();
    for (const mid of item.mediaIds) {
      const media = resolvedMedia.get(mid);
      if (!media || seenImg.has(media.url)) continue;
      seenImg.add(media.url);
      images.push({
        loc: media.url,
        title: media.alt || item.dto.data.title,
      });
    }

    entries.push({
      loc: item.canonical,
      lastmod: formatIsoLastmod(item.lastmodMs),
      images,
    });
  }

  return entries;
}

async function collectSitemapEntriesForKind(
  kind: SitemapKind,
  params: {
    readonly scope: ResolvedDiscoveryTenant;
    readonly siteSettings: SiteSettingsSnapshot | null;
    readonly mediaBaseOrigin: string;
  },
): Promise<SitemapUrlEntry[]> {
  switch (kind) {
    case "pages":
      return collectPublishedPageSitemapEntries(params);
    case "posts":
      return collectPublishedPostSitemapEntries(params);
    case "offerings":
      return collectPublishedOfferingSitemapEntries(params);
  }
}

function isTenantSitemapIndexable(
  scope: ResolvedDiscoveryTenant,
  siteSettings: SiteSettingsSnapshot | null,
): boolean {
  if (scope.tenant.status === "trial") return false;
  if (siteSettings?.siteVisibility === "noindex") return false;
  return true;
}

// ---------------------------------------------------------------------------
// 1. Sitemap Index Handler (`GET /sitemap.xml`)
// ---------------------------------------------------------------------------

export async function handleSitemapIndexRequest(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<Response> {
  const scopeRes = await resolveDiscoveryTenantScope(request, deps);

  switch (scopeRes.kind) {
    case "unknown_host":
    case "platform_private":
    case "platform_marketing":
    case "destroyed":
      return createNotFoundResponse(request, XML_CONTENT_TYPE);
    case "suspended":
    case "recovery":
      return createUnavailableResponse(request, scopeRes.retryAfterSeconds, {
        contentType: XML_CONTENT_TYPE,
      });
    case "unavailable":
      return createUnavailableResponse(request, 60, { contentType: XML_CONTENT_TYPE });
    case "alias_redirect":
      return createAliasRedirectResponse(scopeRes.location);
    case "tenant":
      break;
  }

  const { scope } = scopeRes;
  const [siteSettings, seoActive] = await Promise.all([
    loadPublishedSiteSettings(scope.tenantDb),
    isSeoAutopilotActive(scope.tenantDb),
  ]);

  if (!seoActive || !isTenantSitemapIndexable(scope, siteSettings)) {
    return createNotFoundResponse(request, XML_CONTENT_TYPE);
  }

  const mediaBaseOrigin = resolveMediaBaseOrigin(deps.mediaPublicBaseUrl);
  const [pageEntries, postEntries, offeringEntries] = await Promise.all([
    collectPublishedPageSitemapEntries({ scope, siteSettings, mediaBaseOrigin }),
    collectPublishedPostSitemapEntries({ scope, siteSettings, mediaBaseOrigin }),
    collectPublishedOfferingSitemapEntries({ scope, siteSettings, mediaBaseOrigin }),
  ]);

  const byKind: ReadonlyArray<readonly [SitemapKind, readonly SitemapUrlEntry[]]> = [
    ["pages", pageEntries],
    ["posts", postEntries],
    ["offerings", offeringEntries],
  ];

  const indexEntries: SitemapIndexEntry[] = [];
  for (const [kind, entries] of byKind) {
    if (entries.length === 0) continue;
    const chunks = chunkSitemapUrlEntries(entries, {
      maxUrls: deps.maxUrlsPerSitemap,
      maxBytes: deps.maxBytesPerSitemap,
    });
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] ?? [];
      if (chunk.length === 0) continue;
      let latestIso: string | null = null;
      for (const entry of chunk) {
        if (entry.lastmod && (!latestIso || entry.lastmod > latestIso)) {
          latestIso = entry.lastmod;
        }
      }
      indexEntries.push({
        loc: `${scope.verifiedOrigin.origin}${buildSubSitemapPath(kind, i + 1)}`,
        lastmod: latestIso,
      });
    }
  }

  const xml = buildSitemapIndexXml(indexEntries);
  const headers = buildPublicDiscoveryHeaders({
    contentType: XML_CONTENT_TYPE,
    tenantId: scope.tenant.id,
    cacheVersion: scope.tenant.cacheVersion,
    resourceKey: "sitemap-index",
  });

  return createResponse(request, xml, 200, headers);
}

// ---------------------------------------------------------------------------
// 2. Sub-Sitemap Handler (`GET /sitemaps/{pages,posts,offerings}[-N].xml`)
// ---------------------------------------------------------------------------

export async function handleSubSitemapRequest(
  request: Request,
  rawKindParam: string | undefined,
  deps: DiscoveryHandlerDeps,
): Promise<Response> {
  const parsedParam = parseSubSitemapParam(rawKindParam);
  if (!parsedParam) {
    return createNotFoundResponse(request, XML_CONTENT_TYPE);
  }

  const scopeRes = await resolveDiscoveryTenantScope(request, deps);

  switch (scopeRes.kind) {
    case "unknown_host":
    case "platform_private":
    case "platform_marketing":
    case "destroyed":
      return createNotFoundResponse(request, XML_CONTENT_TYPE);
    case "suspended":
    case "recovery":
      return createUnavailableResponse(request, scopeRes.retryAfterSeconds, {
        contentType: XML_CONTENT_TYPE,
      });
    case "unavailable":
      return createUnavailableResponse(request, 60, { contentType: XML_CONTENT_TYPE });
    case "alias_redirect":
      return createAliasRedirectResponse(scopeRes.location);
    case "tenant":
      break;
  }

  const { scope } = scopeRes;
  const [siteSettings, seoActive] = await Promise.all([
    loadPublishedSiteSettings(scope.tenantDb),
    isSeoAutopilotActive(scope.tenantDb),
  ]);

  if (!seoActive || !isTenantSitemapIndexable(scope, siteSettings)) {
    return createNotFoundResponse(request, XML_CONTENT_TYPE);
  }

  if (parsedParam.kind === "posts" && siteSettings?.blogEnabled === false) {
    return createNotFoundResponse(request, XML_CONTENT_TYPE);
  }
  if (parsedParam.kind === "offerings" && siteSettings?.catalogEnabled === false) {
    return createNotFoundResponse(request, XML_CONTENT_TYPE);
  }

  const mediaBaseOrigin = resolveMediaBaseOrigin(deps.mediaPublicBaseUrl);
  const entries = await collectSitemapEntriesForKind(parsedParam.kind, {
    scope,
    siteSettings,
    mediaBaseOrigin,
  });

  const chunks = chunkSitemapUrlEntries(entries, {
    maxUrls: deps.maxUrlsPerSitemap,
    maxBytes: deps.maxBytesPerSitemap,
  });

  const chunk = chunks[parsedParam.chunkIndex - 1];
  if (!chunk) {
    return createNotFoundResponse(request, XML_CONTENT_TYPE);
  }

  const xml = buildUrlsetXml(chunk);
  const headers = buildPublicDiscoveryHeaders({
    contentType: XML_CONTENT_TYPE,
    tenantId: scope.tenant.id,
    cacheVersion: scope.tenant.cacheVersion,
    resourceKey: `sitemap-${parsedParam.kind}-${parsedParam.chunkIndex}`,
  });

  return createResponse(request, xml, 200, headers);
}

// ---------------------------------------------------------------------------
// 3. Managed `/robots.txt` Handler (Delegates Strictly to TASK-051)
// ---------------------------------------------------------------------------

export async function handleRobotsTxtRequest(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<Response> {
  const scopeRes = await resolveDiscoveryTenantScope(request, deps);

  switch (scopeRes.kind) {
    case "unknown_host":
    case "destroyed":
      // Unknown/destroyed hosts NEVER receive another tenant's sitemap; emit safe Disallow: /
      return createResponse(request, ROBOTS_DISALLOW_ALL_BODY, 404, {
        "Content-Type": TEXT_CONTENT_TYPE,
        ...NO_STORE_HEADERS,
      });
    case "platform_private":
      // `app.punyasitus.com` & `console.punyasitus.com`: strictly Disallow: /, noindex, no sitemap
      return createResponse(request, ROBOTS_DISALLOW_ALL_BODY, 200, {
        "Content-Type": TEXT_CONTENT_TYPE,
        ...NO_STORE_HEADERS,
      });
    case "platform_marketing":
      return createResponse(
        request,
        [
          "User-agent: *",
          "Allow: /",
          "Disallow: /api/",
          "Disallow: /dashboard/",
          "Disallow: /console/",
          "Disallow: /auth/",
          "Disallow: /account/",
          "Disallow: /preview",
        ].join("\n") + "\n",
        200,
        {
          "Content-Type": TEXT_CONTENT_TYPE,
          "Cache-Control": `public, max-age=${DISCOVERY_CACHE_MAX_AGE_SECONDS}`,
        },
      );
    case "suspended":
    case "recovery":
      return createUnavailableResponse(request, scopeRes.retryAfterSeconds, {
        body: ROBOTS_DISALLOW_ALL_BODY,
        contentType: TEXT_CONTENT_TYPE,
      });
    case "unavailable":
      return createUnavailableResponse(request, 60, {
        body: ROBOTS_DISALLOW_ALL_BODY,
        contentType: TEXT_CONTENT_TYPE,
      });
    case "alias_redirect":
      return createAliasRedirectResponse(scopeRes.location);
    case "tenant":
      break;
  }

  const { scope } = scopeRes;
  const [siteSettings, seoActive] = await Promise.all([
    loadPublishedSiteSettings(scope.tenantDb),
    isSeoAutopilotActive(scope.tenantDb),
  ]);

  const aiTrainingPolicy: AiTrainingPolicy = siteSettings?.aiTrainingPolicy ?? "allow";
  const siteVisibility: SiteVisibility = siteSettings?.siteVisibility ?? "public";

  const policy = buildRobotsTxtPolicy({
    tenant: scope.seoTenant,
    aiTrainingPolicy,
    siteVisibility,
  });

  // REQ-066: When `seo-ai-autopilot` is explicitly disabled on an active paid site,
  // omit the Sitemap directive while preserving mandatory safety rules.
  const body =
    !seoActive && policy.indexable && policy.sitemapUrl
      ? `${policy.body.replace(`\n\nSitemap: ${policy.sitemapUrl}\n`, "\n")}`
      : policy.body;

  const headers = buildPublicDiscoveryHeaders({
    contentType: policy.contentType,
    tenantId: scope.tenant.id,
    cacheVersion: scope.tenant.cacheVersion,
    resourceKey: "robots",
    noStore: policy.cacheControl === "no-store" || policy.httpStatus !== 200,
    xRobotsTag: policy.xRobotsTag,
  });

  if (policy.retryAfterSeconds !== null) {
    headers.set("Retry-After", String(policy.retryAfterSeconds));
  }

  return createResponse(request, body, policy.httpStatus, headers);
}

// ---------------------------------------------------------------------------
// 4. Blog RSS 2.0 Feed Handler (`GET /blog/feed.xml`)
// ---------------------------------------------------------------------------

function extractPlainExcerptFromPost(post: PostSnapshot): string {
  if (post.excerpt && post.excerpt.trim()) {
    return sanitizeSeoText(post.excerpt, { maxLength: 500 });
  }
  const chunks: string[] = [];
  for (const block of post.body.blocks) {
    if (block.text && block.text.trim()) {
      chunks.push(block.text.trim());
    }
    if (chunks.join(" ").length >= 300) break;
  }
  return sanitizeSeoText(chunks.join(" "), { maxLength: 300 });
}

export async function handleBlogFeedRequest(
  request: Request,
  deps: DiscoveryHandlerDeps,
): Promise<Response> {
  const scopeRes = await resolveDiscoveryTenantScope(request, deps);

  switch (scopeRes.kind) {
    case "unknown_host":
    case "platform_private":
    case "platform_marketing":
    case "destroyed":
      return createNotFoundResponse(request, RSS_CONTENT_TYPE);
    case "suspended":
    case "recovery":
      return createUnavailableResponse(request, scopeRes.retryAfterSeconds, {
        contentType: RSS_CONTENT_TYPE,
      });
    case "unavailable":
      return createUnavailableResponse(request, 60, { contentType: RSS_CONTENT_TYPE });
    case "alias_redirect":
      return createAliasRedirectResponse(scopeRes.location);
    case "tenant":
      break;
  }

  const { scope } = scopeRes;
  const siteSettings = await loadPublishedSiteSettings(scope.tenantDb);

  // Absent (404) when the tenant's blog feature is disabled (PLAN §15.7, REQ-024)
  if (siteSettings?.blogEnabled === false) {
    return createNotFoundResponse(request, RSS_CONTENT_TYPE);
  }

  // Bounded query with headroom in case some top published posts are marked `noindex`
  const QUERY_BATCH_LIMIT = 60;
  const MAX_SCAN_ROWS = 300;
  const selected: Array<{
    readonly dto: PublishedResourceDto<"post">;
    readonly canonical: string;
    readonly pubDateMs: number;
  }> = [];

  let offset = 0;
  while (selected.length < MAX_RSS_FEED_ITEMS && offset < MAX_SCAN_ROWS) {
    const res = await scope.tenantDb
      .prepare(
        `SELECT id, slug, title, excerpt, published_body_json, primary_category_id,
                author_id, cover_media_id, reading_time_minutes, show_toc, seo_json,
                status, published_at, content_modified_at, deleted_at, version, updated_at
         FROM posts
         WHERE status = 'published'
           AND deleted_at IS NULL
           AND published_body_json IS NOT NULL
         ORDER BY published_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(QUERY_BATCH_LIMIT, offset)
      .all<RawPostPublishedRow>();

    if (res.results.length === 0) break;
    offset += res.results.length;

    for (const row of res.results) {
      if (selected.length >= MAX_RSS_FEED_ITEMS) break;

      let dto: PublishedResourceDto<"post"> | null;
      try {
        dto = extractPublishedSnapshot("post", {
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
        continue;
      }
      if (!dto) continue;

      // Exclude posts with explicit per-resource `noindex: true`
      if (dto.data.seo?.noindex === true) continue;

      const decision = resolvePublishedResourceSeoDecision({
        tenant: scope.seoTenant,
        siteSettings,
        resource: dto,
        canonicalOverride: dto.data.seo?.canonicalOverride ?? null,
      });

      if (decision.httpStatus !== 200 || !decision.canonical) continue;
      // On active paid sites, enforce full sitemap/indexability eligibility
      if (scope.tenant.status !== "trial" && siteSettings?.siteVisibility !== "noindex") {
        if (!decision.sitemapEligible) continue;
      }

      const pubDateMs = dto.publishedAt ?? dto.contentModifiedAt ?? 0;
      if (pubDateMs <= 0) continue;

      selected.push({
        dto,
        canonical: decision.canonical,
        pubDateMs,
      });
    }

    if (res.results.length < QUERY_BATCH_LIMIT) break;
  }

  // Batch-load featured cover images for the selected posts
  const coverMediaIds = new Set<number>();
  for (const item of selected) {
    if (item.dto.data.coverMediaId) {
      coverMediaIds.add(item.dto.data.coverMediaId);
    }
  }

  const mediaBaseOrigin = resolveMediaBaseOrigin(deps.mediaPublicBaseUrl);
  const resolvedMedia = await loadVerifiedTenantImagesById(
    scope.tenant.id,
    scope.tenantDb,
    coverMediaIds,
    mediaBaseOrigin,
  );

  const feedItems: RssFeedItemEntry[] = [];
  for (const item of selected) {
    const pubDate = formatRfc2822Date(item.pubDateMs);
    if (!pubDate) continue;
    const coverMedia = item.dto.data.coverMediaId
      ? resolvedMedia.get(item.dto.data.coverMediaId) ?? null
      : null;

    feedItems.push({
      title: sanitizeSeoText(item.dto.data.title, { maxLength: 200 }),
      link: item.canonical,
      guid: item.canonical,
      pubDate,
      description: extractPlainExcerptFromPost(item.dto.data),
      image: coverMedia
        ? {
            url: coverMedia.url,
            bytes: coverMedia.bytes,
            mimeType: coverMedia.mimeType,
            title: coverMedia.alt || item.dto.data.title,
          }
        : null,
    });
  }

  const latestBuildMs = maxTimestampMs(
    selected.map((item) => getEffectiveLastmodMs(item.dto)),
  );
  const siteTitle = sanitizeSeoText(siteSettings?.siteTitle ?? scope.tenant.name, {
    maxLength: 120,
  }) || "Blog";
  const siteDescription =
    sanitizeSeoText(siteSettings?.tagline ?? "", { maxLength: 240 }) ||
    `Artikel terbaru dari ${siteTitle}`;

  const xml = buildBlogRssFeedXml(
    {
      title: siteTitle,
      link: `${scope.verifiedOrigin.origin}/blog`,
      feedUrl: `${scope.verifiedOrigin.origin}/blog/feed.xml`,
      description: siteDescription,
      language: siteSettings?.locale ?? "id-ID",
      lastBuildDate: formatRfc2822Date(latestBuildMs),
    },
    feedItems,
  );

  const isNonIndexableTenant =
    scope.tenant.status === "trial" || siteSettings?.siteVisibility === "noindex";
  const headers = buildPublicDiscoveryHeaders({
    contentType: RSS_CONTENT_TYPE,
    tenantId: scope.tenant.id,
    cacheVersion: scope.tenant.cacheVersion,
    resourceKey: "blog-feed",
    noStore: isNonIndexableTenant,
    xRobotsTag: isNonIndexableTenant ? "noindex, nofollow" : null,
  });

  return createResponse(request, xml, 200, headers);
}
