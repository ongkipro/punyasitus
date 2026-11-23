import {
  classifySurfaceHost,
  normalizeHost,
  PLATFORM_HOSTS,
} from "@punyasitus/core";
import {
  getOfferingPublicPath,
  type CatalogOfferingType,
} from "@punyasitus/core/catalog/index";
import {
  extractPublishedSnapshot,
  type OfferingSnapshot,
  type PublishedResourceDto,
} from "@punyasitus/core/content/index";
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
  type SchemaGraphDocument,
} from "@punyasitus/core/schema-generator";
import {
  resolveVerifiedCanonicalOrigin,
  sanitizeSeoText,
  type PublishedSeoDecisionInput,
  type VerifiedCanonicalOrigin,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
import {
  getTaxonomyPublicBasePath,
  type TaxonomyKind,
} from "@punyasitus/core/taxonomy/index";
import {
  createTenantDb,
  openTenantStoreStub,
} from "@punyasitus/db/connections";
import { resolveTenantByHost } from "@punyasitus/db/routing/index";
import {
  listTaxonomies,
  resolveTaxonomyByPublicSlug,
  type TaxonomyRecord,
} from "@punyasitus/db/taxonomy/index";
import { CACHE_VERSION_HEADER_NAME } from "../../../core/cache.ts";
import {
  loadPublishedTenantShellData,
  type TenantShellData,
} from "../../../core/public-data.ts";
import {
  buildPreservedRedirectQuery,
  DEFAULT_BLOG_PAGE_SIZE,
  DEFAULT_OFFERING_PAGE_SIZE,
  formatPublicIndonesianDate,
  formatPublicOfferingPrice,
  getVehicleUnitStatusLabel,
  inspectSingleSlugParam,
  OFFERING_ROUTE_META,
  parsePublicPaginationQuery,
  PUBLIC_CACHE_MAX_AGE_SECONDS,
  resolvePublicOfferingCta,
  type OfferingRouteDescriptor,
  type PublicBlogListItem,
  type PublicBreadcrumbItem,
  type PublicBrandedNotFoundResult,
  type PublicFloatingWaModel,
  type PublicImmediateResponseResult,
  type PublicOfferingListItem,
  type PublicPaginationState,
  type PublicResolvedImage,
  type PublicRouteDeps,
  type PublicRouteHttpMeta,
} from "../../../core/public-routes.ts";
import { formatIdrPlain } from "../../../core/section-registry.ts";
import {
  createStatePageResponse,
  type TenantContext,
} from "../../../core/tenant.ts";

/**
 * Runtime-Neutral Public Taxonomy Archive Resolver (Zero-JS SSR)
 * (`apps/web/src/pages/blog/category/_archive-resolver.ts`; TASK-041, REQ-045, PLAN §11.3 & §15.2).
 *
 * Powers all 6 public taxonomy archive routes:
 * - `/blog/category/[slug]`
 * - `/blog/tag/[slug]`
 * - `/layanan/category/[slug]`
 * - `/produk/category/[slug]`
 * - `/tour/category/[slug]`
 * - `/kendaraan/category/[slug]`
 */

export interface PublicChildCategoryLink {
  readonly slug: string;
  readonly name: string;
  readonly href: string;
  readonly publishedCount: number;
}

export interface PublicBlogTaxonomyArchiveRenderResult {
  readonly kind: "blog_taxonomy_archive";
  readonly taxonomyKind: "post_category" | "post_tag";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly pageTitle: string;
  readonly taxonomy: TaxonomyRecord;
  readonly childCategories: readonly PublicChildCategoryLink[];
  readonly items: readonly PublicBlogListItem[];
  readonly pagination: PublicPaginationState;
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly floatingWa: PublicFloatingWaModel;
}

export interface PublicOfferingCategoryArchiveRenderResult {
  readonly kind: "offering_category_archive";
  readonly http: PublicRouteHttpMeta;
  readonly tenant: TenantContext;
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly currentPath: string;
  readonly descriptor: OfferingRouteDescriptor;
  readonly pageTitle: string;
  readonly taxonomy: TaxonomyRecord;
  readonly childCategories: readonly PublicChildCategoryLink[];
  readonly items: readonly PublicOfferingListItem[];
  readonly pagination: PublicPaginationState;
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly floatingWa: PublicFloatingWaModel;
}

export type PublicBlogTaxonomyArchiveRouteResult =
  | PublicImmediateResponseResult
  | PublicBrandedNotFoundResult
  | PublicBlogTaxonomyArchiveRenderResult;

export type PublicOfferingCategoryArchiveRouteResult =
  | PublicImmediateResponseResult
  | PublicBrandedNotFoundResult
  | PublicOfferingCategoryArchiveRenderResult;

interface ResolvedScope {
  readonly tenant: TenantContext;
  readonly tenantDb: D1Database;
  readonly seoTenant: VerifiedTenantHostInput;
  readonly verifiedOrigin: VerifiedCanonicalOrigin;
  readonly mediaBaseOrigin: string;
}

interface RawPostRow {
  readonly id: number;
  readonly slug: string;
  readonly published_body_json: string | null;
  readonly status: "draft" | "published" | "trashed";
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
}

interface RawOfferingRow {
  readonly id: number;
  readonly offering_type: CatalogOfferingType;
  readonly slug: string;
  readonly published_snapshot_json: string | null;
  readonly status: "draft" | "published" | "trashed";
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
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
}

function buildSeoTenantInput(tenant: TenantContext): VerifiedTenantHostInput {
  const verifiedHosts = new Set<string>([tenant.host]);
  if (tenant.primaryHost) verifiedHosts.add(tenant.primaryHost);
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
  if (normalizedHost === `app.${cleanPlatform}`) return "app";
  if (normalizedHost === `console.${cleanPlatform}`) return "console";
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

async function resolveScope(
  request: Request,
  deps: PublicRouteDeps,
  explicitUrl?: URL,
): Promise<
  | { readonly kind: "ok"; readonly scope: ResolvedScope }
  | { readonly kind: "response"; readonly result: PublicImmediateResponseResult }
> {
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

  if (deps.surface === "app" || deps.surface === "console" || deps.surface === "marketing") {
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
          response: createStatePageResponse("not_found", { pathname, surface: platformSurface }),
        },
      };
    }
  }

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

  if (!tenantDb && deps.tenantStore) {
    try {
      tenantDb = createTenantDb(openTenantStoreStub(deps.tenantStore, tenant.id));
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

function buildPublicHeaders(params: {
  readonly status: 200 | 404;
  readonly tenant: TenantContext;
  readonly xRobotsTag: string | null;
}): PublicRouteHttpMeta {
  const headers: Record<string, string> = {
    "X-PunyaSitus-Surface": "tenant",
    [CACHE_VERSION_HEADER_NAME]: String(params.tenant.cacheVersion),
  };
  if (params.status === 404) {
    headers["Cache-Control"] = "no-store";
    headers["X-Robots-Tag"] = "noindex, nofollow";
  } else if (params.tenant.status === "trial") {
    headers["Cache-Control"] = "private, no-store";
    headers["X-Robots-Tag"] = "noindex, nofollow";
  } else {
    headers["Cache-Control"] = `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}, s-maxage=${PUBLIC_CACHE_MAX_AGE_SECONDS}`;
    if (params.xRobotsTag) {
      headers["X-Robots-Tag"] = params.xRobotsTag;
    }
  }
  return { status: params.status, headers };
}

function buildFloatingWaModel(params: {
  readonly shell: TenantShellData;
  readonly primaryOrigin: string;
  readonly canonicalPath: string;
  readonly itemTitle: string;
}): PublicFloatingWaModel {
  return {
    phone: params.shell.business.whatsappE164 ?? params.shell.business.phone ?? null,
    businessName: params.shell.business.name || params.shell.site.title,
    operatingHours: params.shell.business.weekdayHours ?? null,
    holidayHours: params.shell.business.holidayHours ?? null,
    primaryOrigin: params.primaryOrigin,
    canonicalPath: params.canonicalPath,
    itemTitle: params.itemTitle,
    greetingMessage: `Halo ${params.shell.business.name || params.shell.site.title}, saya ingin bertanya lebih lanjut mengenai ${params.itemTitle}.`,
  };
}

function buildSchemaBusinessProfile(shell: TenantShellData): SchemaBusinessProfileInput {
  return {
    businessName: shell.business.name || shell.site.title,
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
  items: readonly PublicBreadcrumbItem[],
): readonly SchemaBreadcrumbItemInput[] {
  return items.map((item) => ({
    label: item.label,
    ...(item.href ? { path: item.href } : {}),
  }));
}

function buildBrandedNotFound(params: {
  readonly scope: ResolvedScope;
  readonly shell: TenantShellData;
  readonly currentPath: string;
  readonly heading?: string;
  readonly message?: string;
}): PublicBrandedNotFoundResult {
  const heading = params.heading ?? "Arsip Tidak Ditemukan";
  const message =
    params.message ??
    "Kategori atau tag yang Anda cari tidak tersedia atau telah dihapus.";

  const seoMetadata = generateOpenGraphMetadata({
    seo: {
      surface: "error",
      routeKind: "error_404",
      pathname: params.currentPath,
      tenant: null,
    },
    tenantId: params.scope.tenant.id,
    siteName: params.shell.site.title,
    siteTagline: params.shell.site.tagline,
    locale: params.shell.site.locale,
    resourceTitle: heading,
    resourceExcerpt: message,
    allowedMediaOrigins: [params.scope.mediaBaseOrigin],
  });

  return {
    kind: "not_found",
    http: buildPublicHeaders({
      status: 404,
      tenant: params.scope.tenant,
      xRobotsTag: "noindex, nofollow",
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

async function loadVerifiedImages(
  tenantId: string,
  tenantDb: D1Database,
  mediaIds: ReadonlySet<number>,
  mediaBaseOrigin: string,
): Promise<Map<number, PublicResolvedImage>> {
  const result = new Map<number, PublicResolvedImage>();
  const ids = [...mediaIds].filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<RawMediaRow>();

  for (const row of res.results) {
    if (row.kind !== "image" || row.status !== "ready") continue;
    if (row.deleted_at !== undefined && row.deleted_at !== null) continue;
    const variants = parseVariantsManifest(row.variants_json);
    const preferred = variants?.w1280 ?? variants?.master ?? variants?.w640 ?? variants?.og ?? null;
    const candidateKey = preferred?.key ?? row.r2_key;
    if (!candidateKey) continue;

    let verifiedKey: string;
    try {
      verifiedKey = assertTenantR2Key(tenantId, candidateKey, ["media"]);
    } catch {
      continue;
    }

    const url = `${mediaBaseOrigin}/${verifiedKey.replace(/^\/+/, "")}`;
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

    result.set(Number(row.id), {
      id: Number(row.id),
      url,
      alt,
      width: Math.max(1, Number(width) || 1200),
      height: Math.max(1, Number(height) || 800),
      mimeType: preferred?.mimeType ?? (row.mime_type || "image/webp"),
      bytes: preferred?.bytes ?? Number(row.bytes ?? 0),
      r2Key: verifiedKey,
      ogCandidate,
    });
  }

  return result;
}

async function loadAuthors(
  tenantDb: D1Database,
  authorIds: ReadonlySet<number>,
): Promise<Map<number, RawAuthorRow>> {
  const map = new Map<number, RawAuthorRow>();
  const ids = [...authorIds].filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (ids.length === 0) return map;

  const placeholders = ids.map(() => "?").join(", ");
  const res = await tenantDb
    .prepare(`SELECT id, name FROM authors WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<RawAuthorRow>();

  for (const row of res.results) {
    map.set(Number(row.id), row);
  }
  return map;
}

async function loadAncestorChain(
  tenantDb: D1Database,
  taxonomy: TaxonomyRecord,
  offeringType?: CatalogOfferingType,
): Promise<PublicBreadcrumbItem[]> {
  if (taxonomy.kind === "post_tag" || taxonomy.parentId === null) {
    return [];
  }

  const allSameKind = await listTaxonomies(tenantDb, {
    kind: taxonomy.kind,
    ...(offeringType ? { offeringType } : {}),
    limit: 100,
    sortOrder: "asc",
  });
  const byId = new Map<number, TaxonomyRecord>();
  for (const item of allSameKind.items) {
    byId.set(item.id, item);
  }

  const ancestors: TaxonomyRecord[] = [];
  const visited = new Set<number>([taxonomy.id]);
  let cursor: number | null = taxonomy.parentId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    ancestors.unshift(parent);
    cursor = parent.parentId;
  }

  return ancestors.map((anc) => ({
    label: anc.name,
    href: getTaxonomyPublicBasePath(anc.kind, anc.slug, offeringType ?? anc.offeringType),
  }));
}

async function loadChildCategoryLinks(
  tenantDb: D1Database,
  taxonomy: TaxonomyRecord,
  offeringType?: CatalogOfferingType,
): Promise<PublicChildCategoryLink[]> {
  if (taxonomy.kind === "post_tag") return [];
  const children = await listTaxonomies(tenantDb, {
    kind: taxonomy.kind,
    ...(offeringType ? { offeringType } : {}),
    parentId: taxonomy.id,
    limit: 50,
    sortOrder: "asc",
  });
  // Filter strictly to child categories with published content so draft-only categories NEVER leak publicly!
  return children.items
    .filter((child) => child.publishedCount > 0)
    .map((child) => ({
      slug: child.slug,
      name: child.name,
      href: getTaxonomyPublicBasePath(child.kind, child.slug, offeringType ?? child.offeringType),
      publishedCount: child.publishedCount,
    }));
}

/**
 * Resolves `/blog/category/[slug]` and `/blog/tag/[slug]`.
 */
async function resolveBlogTaxonomyArchive(
  request: Request,
  deps: PublicRouteDeps,
  taxonomyKind: "post_category" | "post_tag",
  rawSlug: string | undefined | null,
  options?: { readonly url?: URL; readonly pageSize?: number },
): Promise<PublicBlogTaxonomyArchiveRouteResult> {
  const scopeRes = await resolveScope(request, deps, options?.url);
  if (scopeRes.kind === "response") return scopeRes.result;
  const { scope } = scopeRes;
  const reqUrl = normalizeRequestUrl(request, options?.url);

  const shell = await loadPublishedTenantShellData(scope.tenantDb, {
    fallbackSiteTitle: scope.tenant.name,
    fallbackBusinessName: scope.tenant.name,
  });

  const routePrefix = taxonomyKind === "post_category" ? "/blog/category" : "/blog/tag";

  if (!shell.site.blogEnabled) {
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? routePrefix,
      heading: "Blog Tidak Tersedia",
      message: "Bagian blog saat ini tidak diaktifkan pada situs ini.",
    });
  }

  const inspected = inspectSingleSlugParam(rawSlug);
  if (inspected.kind === "invalid") {
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? routePrefix,
    });
  }

  const normalizedSlug = inspected.kind === "canonical" ? inspected.slug : inspected.canonicalSlug;
  const isMixedCase = inspected.kind === "mixed_case";
  const preservedQuery = buildPreservedRedirectQuery(reqUrl?.searchParams);

  const taxLookup = await resolveTaxonomyByPublicSlug(scope.tenantDb, {
    kind: taxonomyKind,
    slug: normalizedSlug,
  });

  if (taxLookup.kind === "not_found") {
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: `${routePrefix}/${normalizedSlug}`,
    });
  }

  if (taxLookup.kind === "former_slug_redirect") {
    return {
      kind: "response",
      reason: "former_slug_redirect",
      response: createRedirectResponse(
        `${scope.verifiedOrigin.origin}${routePrefix}/${taxLookup.targetSlug}${preservedQuery}`,
        308,
        { isTrial: scope.tenant.status === "trial" },
      ),
    };
  }

  const { taxonomy } = taxLookup;
  const basePath = `${routePrefix}/${taxonomy.slug}`;

  if (isMixedCase) {
    return {
      kind: "response",
      reason: "mixed_case_slug_redirect",
      response: createRedirectResponse(
        `${scope.verifiedOrigin.origin}${basePath}${preservedQuery}`,
        308,
        { isTrial: scope.tenant.status === "trial" },
      ),
    };
  }

  // Load ONLY published, non-trashed posts with valid frozen snapshots
  const allRowsRes = await scope.tenantDb
    .prepare(
      `SELECT id, slug, published_body_json, status, published_at, content_modified_at, deleted_at, version
       FROM posts
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND published_body_json IS NOT NULL
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC`,
    )
    .all<RawPostRow>();

  const matchingPosts: { readonly row: RawPostRow; readonly dto: PublishedResourceDto<"post"> }[] = [];
  for (const row of allRowsRes.results) {
    const dto = extractPublishedSnapshot("post", {
      resourceId: Number(row.id),
      status: row.status,
      deletedAt: row.deleted_at,
      publishedJson: row.published_body_json,
      version: Number(row.version ?? 1),
    });
    if (!dto) continue;

    const matches =
      taxonomyKind === "post_category"
        ? dto.data.primaryCategoryId === taxonomy.id ||
          (dto.data.categoryIds ?? []).includes(taxonomy.id)
        : (dto.data.tagIds ?? []).includes(taxonomy.id);

    if (matches) {
      matchingPosts.push({ row, dto });
    }
  }

  const paginationDecision = parsePublicPaginationQuery({
    searchParams: reqUrl?.searchParams ?? new URLSearchParams(),
    basePath,
    origin: scope.verifiedOrigin.origin,
    totalItems: matchingPosts.length,
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
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: basePath,
      heading: "Halaman Arsip Tidak Ditemukan",
      message: "Nomor halaman arsip yang Anda minta tidak tersedia.",
    });
  }

  const { pagination } = paginationDecision;
  const pageSlice = matchingPosts.slice(pagination.offset, pagination.offset + pagination.pageSize);

  const mediaIds = new Set<number>();
  const authorIds = new Set<number>();
  for (const { dto } of pageSlice) {
    if (dto.data.coverMediaId) mediaIds.add(dto.data.coverMediaId);
    if (dto.data.authorId) authorIds.add(dto.data.authorId);
  }

  const [imagesById, authorsById, ancestorCrumbs, childCategories] = await Promise.all([
    loadVerifiedImages(scope.tenant.id, scope.tenantDb, mediaIds, scope.mediaBaseOrigin),
    loadAuthors(scope.tenantDb, authorIds),
    loadAncestorChain(scope.tenantDb, taxonomy),
    loadChildCategoryLinks(scope.tenantDb, taxonomy),
  ]);

  const items: PublicBlogListItem[] = pageSlice.map(({ row, dto }) => {
    const publishedIso = toIsoOrNull(row.published_at);
    const authorName =
      dto.data.authorName ??
      (dto.data.authorId ? authorsById.get(dto.data.authorId)?.name ?? null : null);
    return {
      slug: dto.data.slug,
      href: `/blog/${dto.data.slug}`,
      title: dto.data.title,
      excerpt: dto.data.excerpt ?? null,
      authorName,
      categoryName: taxonomyKind === "post_category" ? taxonomy.name : null,
      publishedAtIso: publishedIso,
      publishedDateLabel: formatPublicIndonesianDate(publishedIso, shell.site.timezone),
      readingTimeMinutes: dto.data.readingTimeMinutes || 1,
      coverImage: dto.data.coverMediaId ? imagesById.get(dto.data.coverMediaId) ?? null : null,
    };
  });

  const labelPrefix = taxonomyKind === "post_category" ? "Kategori" : "Tag";
  const heading = `${labelPrefix}: ${taxonomy.name}`;
  const pageTitle = pagination.page > 1 ? `${heading} — Halaman ${pagination.page}` : heading;
  const description =
    taxonomy.description ??
    `Kumpulan artikel dalam ${labelPrefix.toLowerCase()} ${taxonomy.name} di ${shell.business.name}.`;
  const currentPath = pagination.page > 1 ? `${basePath}?page=${pagination.page}` : basePath;

  const seoQuery = new URLSearchParams();
  if (pagination.page > 1) seoQuery.set("page", String(pagination.page));

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind: taxonomyKind === "post_category" ? "category_archive" : "tag_archive",
    pathname: basePath,
    query: seoQuery,
    tenant: scope.seoTenant,
    siteVisibility: shell.site.siteVisibility,
    resourceState: "published",
    archiveEnabled: true,
    publishedItemCount: pagination.totalItems,
    totalPages: pagination.totalPages,
    taxonomyIndexOptIn: taxonomy.indexOptIn,
    taxonomyHasUsefulIntro: taxonomy.hasUsefulIntro,
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
    { label: "Blog", href: "/blog" },
    ...ancestorCrumbs,
    { label: taxonomy.name, href: pagination.page > 1 ? basePath : null },
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
    pageDescription: description,
    breadcrumbs: toSchemaBreadcrumbs(breadcrumbs),
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  return {
    kind: "blog_taxonomy_archive",
    taxonomyKind,
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
    taxonomy,
    childCategories,
    items,
    pagination,
    breadcrumbs,
    seoMetadata,
    schemaGraph: schemaRes.graph,
    floatingWa: buildFloatingWaModel({
      shell,
      primaryOrigin: scope.verifiedOrigin.origin,
      canonicalPath: basePath,
      itemTitle: `${labelPrefix} ${taxonomy.name}`,
    }),
  };
}

export function resolveBlogCategoryArchiveRoute(
  request: Request,
  deps: PublicRouteDeps,
  rawSlug: string | undefined | null,
  options?: { readonly url?: URL; readonly pageSize?: number },
): Promise<PublicBlogTaxonomyArchiveRouteResult> {
  return resolveBlogTaxonomyArchive(request, deps, "post_category", rawSlug, options);
}

export function resolveBlogTagArchiveRoute(
  request: Request,
  deps: PublicRouteDeps,
  rawSlug: string | undefined | null,
  options?: { readonly url?: URL; readonly pageSize?: number },
): Promise<PublicBlogTaxonomyArchiveRouteResult> {
  return resolveBlogTaxonomyArchive(request, deps, "post_tag", rawSlug, options);
}

function buildOfferingMetaLine(snap: OfferingSnapshot): string | null {
  const attrs = (snap.verticalAttributes ?? snap.attributes ?? {}) as Record<string, unknown>;
  if (snap.offeringType === "vehicle") {
    const parts: string[] = [];
    if (typeof attrs.year === "number") parts.push(String(attrs.year));
    if (typeof attrs.transmission === "string") parts.push(attrs.transmission);
    if (typeof attrs.fuelType === "string") parts.push(attrs.fuelType);
    return parts.length > 0 ? parts.join(" • ") : null;
  }
  if (snap.offeringType === "tour") {
    const parts: string[] = [];
    if (typeof attrs.durationDays === "number") parts.push(`${attrs.durationDays} Hari`);
    if (typeof attrs.destination === "string" && attrs.destination.trim()) parts.push(attrs.destination.trim());
    return parts.length > 0 ? parts.join(" • ") : null;
  }
  if (snap.offeringType === "service") {
    if (typeof attrs.duration === "string" && attrs.duration.trim()) {
      return `Estimasi: ${attrs.duration.trim()}`;
    }
  }
  if (snap.offeringType === "product") {
    if (typeof attrs.sku === "string" && attrs.sku.trim()) {
      return `SKU: ${attrs.sku.trim()}`;
    }
  }
  return null;
}

/**
 * Resolves `/{layanan|produk|tour|kendaraan}/category/[slug]`.
 */
export async function resolveOfferingCategoryArchiveRoute(
  request: Request,
  deps: PublicRouteDeps,
  offeringType: CatalogOfferingType,
  rawSlug: string | undefined | null,
  options?: { readonly url?: URL; readonly pageSize?: number },
): Promise<PublicOfferingCategoryArchiveRouteResult> {
  const scopeRes = await resolveScope(request, deps, options?.url);
  if (scopeRes.kind === "response") return scopeRes.result;
  const { scope } = scopeRes;
  const reqUrl = normalizeRequestUrl(request, options?.url);
  const descriptor = OFFERING_ROUTE_META[offeringType];
  const routePrefix = `${descriptor.prefix}/category`;

  const shell = await loadPublishedTenantShellData(scope.tenantDb, {
    fallbackSiteTitle: scope.tenant.name,
    fallbackBusinessName: scope.tenant.name,
  });

  if (!shell.site.catalogEnabled) {
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? routePrefix,
      heading: `${descriptor.pluralLabel} Tidak Tersedia`,
      message: "Bagian katalog saat ini tidak diaktifkan pada situs ini.",
    });
  }

  const inspected = inspectSingleSlugParam(rawSlug);
  if (inspected.kind === "invalid") {
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: reqUrl?.pathname ?? routePrefix,
    });
  }

  const normalizedSlug = inspected.kind === "canonical" ? inspected.slug : inspected.canonicalSlug;
  const isMixedCase = inspected.kind === "mixed_case";
  const preservedQuery = buildPreservedRedirectQuery(reqUrl?.searchParams);

  const taxLookup = await resolveTaxonomyByPublicSlug(scope.tenantDb, {
    kind: "offering_category",
    slug: normalizedSlug,
    offeringType,
  });

  if (taxLookup.kind === "not_found") {
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: `${routePrefix}/${normalizedSlug}`,
    });
  }

  if (taxLookup.kind === "former_slug_redirect") {
    return {
      kind: "response",
      reason: "former_slug_redirect",
      response: createRedirectResponse(
        `${scope.verifiedOrigin.origin}${routePrefix}/${taxLookup.targetSlug}${preservedQuery}`,
        308,
        { isTrial: scope.tenant.status === "trial" },
      ),
    };
  }

  const { taxonomy } = taxLookup;
  const basePath = `${routePrefix}/${taxonomy.slug}`;

  if (isMixedCase) {
    return {
      kind: "response",
      reason: "mixed_case_slug_redirect",
      response: createRedirectResponse(
        `${scope.verifiedOrigin.origin}${basePath}${preservedQuery}`,
        308,
        { isTrial: scope.tenant.status === "trial" },
      ),
    };
  }

  // Load ONLY published, non-trashed offerings of this offeringType with valid frozen published snapshots
  const allRowsRes = await scope.tenantDb
    .prepare(
      `SELECT id, offering_type, slug, published_snapshot_json, status, published_at, content_modified_at, deleted_at, version
       FROM offerings
       WHERE offering_type = ?
         AND status = 'published'
         AND deleted_at IS NULL
         AND published_snapshot_json IS NOT NULL
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC`,
    )
    .bind(offeringType)
    .all<RawOfferingRow>();

  const matchingOfferings: { readonly row: RawOfferingRow; readonly dto: PublishedResourceDto<"offering"> }[] = [];
  for (const row of allRowsRes.results) {
    const dto = extractPublishedSnapshot("offering", {
      resourceId: Number(row.id),
      status: row.status,
      deletedAt: row.deleted_at,
      publishedJson: row.published_snapshot_json,
      version: Number(row.version ?? 1),
    });
    if (!dto) continue;
    if ((dto.data.categoryIds ?? []).includes(taxonomy.id)) {
      matchingOfferings.push({ row, dto });
    }
  }

  const paginationDecision = parsePublicPaginationQuery({
    searchParams: reqUrl?.searchParams ?? new URLSearchParams(),
    basePath,
    origin: scope.verifiedOrigin.origin,
    totalItems: matchingOfferings.length,
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
    return buildBrandedNotFound({
      scope,
      shell,
      currentPath: basePath,
      heading: "Halaman Kategori Tidak Ditemukan",
      message: "Nomor halaman arsip kategori yang Anda minta tidak tersedia.",
    });
  }

  const { pagination } = paginationDecision;
  const pageSlice = matchingOfferings.slice(pagination.offset, pagination.offset + pagination.pageSize);

  const mediaIds = new Set<number>();
  for (const { dto } of pageSlice) {
    if (dto.data.coverMediaId) mediaIds.add(dto.data.coverMediaId);
  }

  const [imagesById, ancestorCrumbs, childCategories] = await Promise.all([
    loadVerifiedImages(scope.tenant.id, scope.tenantDb, mediaIds, scope.mediaBaseOrigin),
    loadAncestorChain(scope.tenantDb, taxonomy, offeringType),
    loadChildCategoryLinks(scope.tenantDb, taxonomy, offeringType),
  ]);

  const items: PublicOfferingListItem[] = pageSlice.map(({ dto }) => {
    const snap = dto.data;
    return {
      offeringType,
      slug: snap.slug,
      href: getOfferingPublicPath(offeringType, snap.slug),
      title: snap.title,
      summary: snap.summary ?? null,
      categoryName: taxonomy.name,
      badge: snap.badge ?? null,
      unitStatus: snap.unitStatus ?? null,
      unitStatusLabel: getVehicleUnitStatusLabel(snap.unitStatus),
      priceMode: snap.priceMode,
      priceText: formatPublicOfferingPrice(snap),
      originalPriceText:
        snap.originalAmount !== undefined &&
        snap.originalAmount !== null &&
        snap.priceMode !== "on_request"
          ? formatIdrPlain(snap.originalAmount)
          : null,
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

  const heading = `${descriptor.pluralLabel}: ${taxonomy.name}`;
  const pageTitle = pagination.page > 1 ? `${heading} — Halaman ${pagination.page}` : heading;
  const description =
    taxonomy.description ??
    `Daftar ${descriptor.pluralLabel.toLowerCase()} dalam kategori ${taxonomy.name} dari ${shell.business.name}.`;
  const currentPath = pagination.page > 1 ? `${basePath}?page=${pagination.page}` : basePath;

  const seoQuery = new URLSearchParams();
  if (pagination.page > 1) seoQuery.set("page", String(pagination.page));

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind: "offering_category_archive",
    pathname: basePath,
    query: seoQuery,
    tenant: scope.seoTenant,
    siteVisibility: shell.site.siteVisibility,
    resourceState: "published",
    archiveEnabled: true,
    publishedItemCount: pagination.totalItems,
    totalPages: pagination.totalPages,
    taxonomyIndexOptIn: taxonomy.indexOptIn,
    taxonomyHasUsefulIntro: taxonomy.hasUsefulIntro,
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
    { label: descriptor.pluralLabel, href: descriptor.prefix },
    ...ancestorCrumbs,
    { label: taxonomy.name, href: pagination.page > 1 ? basePath : null },
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
    pageDescription: description,
    breadcrumbs: toSchemaBreadcrumbs(breadcrumbs),
    allowedMediaOrigins: [scope.mediaBaseOrigin],
  });

  return {
    kind: "offering_category_archive",
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
    taxonomy,
    childCategories,
    items,
    pagination,
    breadcrumbs,
    seoMetadata,
    schemaGraph: schemaRes.graph,
    floatingWa: buildFloatingWaModel({
      shell,
      primaryOrigin: scope.verifiedOrigin.origin,
      canonicalPath: basePath,
      itemTitle: `${descriptor.pluralLabel} ${taxonomy.name}`,
    }),
  };
}

export type { TaxonomyKind };
