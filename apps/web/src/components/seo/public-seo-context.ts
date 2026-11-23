import {
  mapBranchesToSchemaInput,
  type BranchRecord,
  type PublicBranchViewInput,
} from "@punyasitus/core/branches/index";
import type { TocHeadingEntry } from "@punyasitus/core/content/index";
import type { SocialMetadataDto } from "@punyasitus/core/og-generator";
import {
  generateSchemaGraph,
  type SchemaArticleInput,
  type SchemaBreadcrumbItemInput,
  type SchemaBusinessProfileInput,
  type SchemaFaqItemInput,
  type SchemaGraphDocument,
  type SchemaImageInput,
  type SchemaOfferingInput,
} from "@punyasitus/core/schema-generator";
import type { SearchAppearanceSettings, VerificationTokensConfig } from "@punyasitus/core/seo/editor";
import type { PublishedSeoDecisionInput, SeoRouteKind, VerifiedTenantHostInput } from "@punyasitus/core/seo/index";
import {
  injectTocHeadingAnchors,
  normalizeAuthorBio,
  sanitizeHtmlInternalLinks,
  sanitizeTenantLocalHref,
  type PublicAuthorProfileDto,
} from "@punyasitus/core/seo/local-entity";
import { getPublicAuthorById } from "@punyasitus/db/authors/index";
import {
  createTenantDb,
  openTenantStoreStub,
} from "@punyasitus/db/connections";
import {
  getPublishedPublicSeoContext,
  loadPublishedTenantInternalLinkTargets,
  type PublishedPublicSeoContext,
} from "@punyasitus/db/seo/index";
import type { TenantShellData } from "../../core/public-data.ts";
import {
  extractFaqItemsFromSections,
  type PublicBlogDetailRenderResult,
  type PublicBlogListItem,
  type PublicBlogListingRenderResult,
  type PublicBreadcrumbItem,
  type PublicOfferingDetailRenderResult,
  type PublicOfferingListingRenderResult,
  type PublicPageRenderResult,
  type PublicRouteDeps,
} from "../../core/public-routes.ts";
import type {
  PublicBlogTaxonomyArchiveRenderResult,
  PublicOfferingCategoryArchiveRenderResult,
} from "../../pages/blog/category/_archive-resolver.ts";

/**
 * Runtime-Neutral Public Route Local-Entity Schema, Author SEO, Branches & Head Enricher
 * (`apps/web/src/components/seo/public-seo-context.ts`; REQ-054, PLAN §15.4 & §15.7, TASK-053).
 *
 * Bridges published `TenantStore` facts (`business_profile_structured`, active `branches`,
 * `authors`, `plg_seo_ai_autopilot__settings`) into the single canonical `<PublicSeoHead>`
 * and `generateSchemaGraph` pipeline without touching `public-routes.ts` or creating a second
 * head/schema engine.
 */

export interface PublicSeoHeadProps {
  readonly metadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly seoAutopilotEnabled: boolean;
  readonly publishedVerificationTokens: VerificationTokensConfig | null;
  readonly blogEnabled: boolean;
  readonly siteName: string;
  readonly searchAppearance: SearchAppearanceSettings | null;
  readonly templateValues?: {
    readonly routeKind: SeoRouteKind;
    readonly title?: string | null;
    readonly tagline?: string | null;
    readonly category?: string | null;
    readonly excerpt?: string | null;
    readonly pageNumber?: number | null;
    readonly hasTitleOverride?: boolean;
    readonly hasDescriptionOverride?: boolean;
  };
}

export interface PublishedTaxonomyChipLink {
  readonly name: string;
  readonly slug: string;
  readonly href: string;
}

export interface EnrichedPublicPageData {
  readonly head: PublicSeoHeadProps;
  readonly activeBranches: readonly PublicBranchViewInput[];
  readonly shouldRenderStandaloneBranches: boolean;
  readonly schemaGraph: SchemaGraphDocument | null;
}

export interface PublicCatalogCtaLink {
  readonly href: string;
  readonly label: string;
}

export interface EnrichedPublicBlogDetailData {
  readonly head: PublicSeoHeadProps;
  readonly sanitizedHtmlWithAnchors: string;
  readonly toc: readonly TocHeadingEntry[];
  readonly showToc: boolean;
  readonly authorProfile: PublicAuthorProfileDto | null;
  readonly categoryLinks: readonly PublishedTaxonomyChipLink[];
  readonly tagLinks: readonly PublishedTaxonomyChipLink[];
  readonly blogIndexHref: string | null;
  readonly catalogCta: PublicCatalogCtaLink | null;
  readonly validatedRelatedPosts: readonly PublicBlogListItem[];
  readonly schemaGraph: SchemaGraphDocument | null;
}

export interface EnrichedPublicOfferingDetailData {
  readonly head: PublicSeoHeadProps;
  readonly sanitizedDescriptionHtml: string | null;
  readonly categoryLinks: readonly PublishedTaxonomyChipLink[];
  readonly schemaGraph: SchemaGraphDocument | null;
}

export const FAIL_CLOSED_PUBLIC_SEO_CONTEXT: PublishedPublicSeoContext = {
  seoAutopilotEnabled: false,
  publishedSettings: null,
  structuredBusiness: null,
  activeBranches: [],
  publishedLogo: null,
};

export interface EnrichedPublicListingData {
  readonly head: PublicSeoHeadProps;
  readonly schemaGraph: SchemaGraphDocument | null;
}

function resolveTenantDbFromDeps(deps: PublicRouteDeps, tenantId: string): D1Database | null {
  if (deps.tenantDb) return deps.tenantDb;
  if (deps.tenantStore && tenantId) {
    try {
      return createTenantDb(openTenantStoreStub(deps.tenantStore, tenantId));
    } catch {
      return null;
    }
  }
  return null;
}

function buildSeoTenantInputFromContext(tenant: PublicPageRenderResult["tenant"]): VerifiedTenantHostInput {
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

function toSchemaBreadcrumbs(
  breadcrumbs: readonly PublicBreadcrumbItem[],
): readonly SchemaBreadcrumbItemInput[] {
  return breadcrumbs.map((crumb) => ({
    label: crumb.label,
    ...(crumb.href ? { path: crumb.href } : {}),
  }));
}

/**
 * Builds an honest Schema.org business input merging published shell facts,
 * TASK-091 structured profile extensions (legalName, privacyContact, credentials,
 * serviceAreas, geo), published logo, and TASK-088 active branches ONLY when
 * branches are visibly rendered on the page (`includeVisibleBranches === true`).
 */
export function buildEnrichedSchemaBusinessProfile(params: {
  readonly shell: TenantShellData;
  readonly seoCtx: PublishedPublicSeoContext | null;
  readonly includeVisibleBranches: boolean;
}): SchemaBusinessProfileInput {
  const { shell, seoCtx, includeVisibleBranches } = params;
  const structured = seoCtx?.structuredBusiness?.businessProfile ?? null;
  const visibleBranches: readonly BranchRecord[] = includeVisibleBranches
    ? (seoCtx?.activeBranches ?? [])
    : [];

  return {
    businessName: structured?.businessName || shell.business.name || shell.site.title,
    legalName: structured?.legalName ?? null,
    businessCategory: structured?.businessCategoryKey ?? shell.business.category,
    description: structured?.description ?? shell.business.description,
    logo: seoCtx?.publishedLogo ?? null,
    phone: structured?.phone ?? shell.business.phone,
    whatsappE164: structured?.whatsappE164 ?? shell.business.whatsappE164,
    publicEmail: structured?.email ?? shell.business.email,
    privacyContact: structured?.privacyContact ?? null,
    personRoleTitle: structured?.personRoleTitle ?? null,
    affiliatedOrgName: structured?.affiliatedOrgName ?? null,
    address: structured?.address ?? shell.business.address,
    city: structured?.city ?? shell.business.city,
    province: structured?.province ?? shell.business.province,
    postalCode: structured?.postalCode ?? shell.business.postalCode,
    latitude: structured?.latitude ?? null,
    longitude: structured?.longitude ?? null,
    mapsUrl: structured?.mapsUrl ?? shell.business.mapsUrl,
    weekdayHours: structured?.weekdayHours ?? shell.business.weekdayHours,
    holidayHours: structured?.holidayHours ?? shell.business.holidayHours,
    closedDays: structured?.closedDays ?? null,
    serviceAreas: structured?.serviceAreas ?? null,
    socialLinks: structured?.socialLinks ?? shell.business.socialLinks,
    credentials: structured?.credentials ?? null,
    branches: visibleBranches.length > 0 ? mapBranchesToSchemaInput(visibleBranches) : null,
  };
}

function extractFaqItemsFromPublicSections(
  sections: readonly unknown[],
): readonly SchemaFaqItemInput[] {
  // Strictly read `config.items` only — matches `SectionFaq.astro` 1:1 for visible-fact parity.
  return extractFaqItemsFromSections(sections);
}

function hasEnabledBranchesSection(sections: readonly unknown[] | null | undefined): boolean {
  if (!sections || sections.length === 0) return false;
  for (const raw of sections) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const sec = raw as Record<string, unknown>;
    if (sec.enabled === false || sec.visible === false) continue;
    const type = typeof sec.type === "string" ? sec.type : typeof sec.kind === "string" ? sec.kind : "";
    if (type === "branches") return true;
  }
  return false;
}

function buildHeadPropsFromSeoContext(params: {
  readonly metadata: SocialMetadataDto;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly shell: TenantShellData;
  readonly seoCtx: PublishedPublicSeoContext | null;
  readonly templateValues: PublicSeoHeadProps["templateValues"];
}): PublicSeoHeadProps {
  return {
    metadata: params.metadata,
    schemaGraph: params.schemaGraph,
    // Fail closed: never default a missing/errored SEO context to `true` (DEC-039).
    seoAutopilotEnabled: params.seoCtx ? params.seoCtx.seoAutopilotEnabled : false,
    publishedVerificationTokens: params.seoCtx?.publishedSettings?.verificationTokens ?? null,
    blogEnabled: params.shell.site.blogEnabled,
    siteName: params.shell.site.title,
    searchAppearance: params.seoCtx?.publishedSettings?.searchAppearance ?? null,
    templateValues: params.templateValues,
  };
}

/**
 * Loads published public SEO context with fail-closed fallback:
 * if `tenantDb` is unavailable or raises a DB error, returns `FAIL_CLOSED_PUBLIC_SEO_CONTEXT`
 * (`seoAutopilotEnabled: false`) so a DB hiccup never leaks autopilot OG/schema/verification
 * tags on a tenant that disabled `seo-ai-autopilot` (`DEC-039`).
 */
export async function loadPublicSeoCtxSafe(
  deps: PublicRouteDeps,
  tenantId: string,
): Promise<PublishedPublicSeoContext> {
  const tenantDb = resolveTenantDbFromDeps(deps, tenantId);
  if (!tenantDb) return FAIL_CLOSED_PUBLIC_SEO_CONTEXT;
  try {
    return await getPublishedPublicSeoContext(tenantDb, {
      tenantId,
      mediaBaseOrigin: deps.mediaPublicBaseUrl ?? null,
    });
  } catch {
    return FAIL_CLOSED_PUBLIC_SEO_CONTEXT;
  }
}

const CATALOG_CTA_CANDIDATES: readonly PublicCatalogCtaLink[] = [
  { href: "/layanan", label: "Lihat Layanan Kami" },
  { href: "/produk", label: "Lihat Produk Kami" },
  { href: "/tour", label: "Lihat Paket Tour" },
  { href: "/kendaraan", label: "Lihat Katalog Kendaraan" },
];

function resolvePublishedCatalogCta(params: {
  readonly catalogEnabled: boolean;
  readonly verifiedOrigin: string;
  readonly publishedPaths: ReadonlySet<string> | null;
}): PublicCatalogCtaLink | null {
  if (!params.catalogEnabled || !params.publishedPaths) return null;
  for (const candidate of CATALOG_CTA_CANDIDATES) {
    const checked = sanitizeTenantLocalHref(candidate.href, {
      verifiedOrigin: params.verifiedOrigin,
      publishedPaths: params.publishedPaths,
      requireLocal: true,
    });
    if (checked.ok && checked.href) {
      return { href: checked.href, label: candidate.label };
    }
  }
  return null;
}

/**
 * Enriches homepage (`/`) and static pages (`/{pageSlug}`) with:
 * - Published structured business profile (`TASK-091`)
 * - Active branches mounted into `SectionBranches` (`TASK-088` handoff) with strict
 *   visible-fact `@graph` parity (`includeVisibleBranches` matches visible DOM!)
 * - `resolvePublishSafeSchemaType` gating (e.g. `FAQPage` only when visible FAQ exists)
 * - Published Search Appearance templates, webmaster verification tags, and RSS discovery link
 */
export async function enrichPublicPageRouteResult(
  result: PublicPageRenderResult,
  deps: PublicRouteDeps,
): Promise<EnrichedPublicPageData> {
  const seoCtx = await loadPublicSeoCtxSafe(deps, result.tenant.id);
  const activeBranches = seoCtx?.activeBranches ?? [];
  const hasExplicitBranchesSection = hasEnabledBranchesSection(result.page?.sections);
  const shouldRenderStandaloneBranches =
    result.isHomepage &&
    result.layoutMode !== "focused" &&
    activeBranches.length > 0 &&
    !hasExplicitBranchesSection;
  const includeVisibleBranches =
    activeBranches.length > 0 && (hasExplicitBranchesSection || shouldRenderStandaloneBranches);

  const faqItems: readonly SchemaFaqItemInput[] = result.page
    ? extractFaqItemsFromPublicSections(result.page.sections)
    : [];
  const routeKind: SeoRouteKind = result.isHomepage ? "homepage" : "page";
  const pageSeo = result.page?.seo as Record<string, unknown> | undefined;
  const rawSchemaType = typeof pageSeo?.schemaType === "string" ? pageSeo.schemaType : null;
  const hasTitleOverride = Boolean(
    (typeof pageSeo?.titleOverride === "string" && pageSeo.titleOverride.trim()) ||
      (typeof pageSeo?.seoTitle === "string" && pageSeo.seoTitle.trim()),
  );
  const hasDescriptionOverride = Boolean(
    (typeof pageSeo?.descriptionOverride === "string" && pageSeo.descriptionOverride.trim()) ||
      (typeof pageSeo?.seoDescription === "string" && pageSeo.seoDescription.trim()),
  );

  const seoInput: PublishedSeoDecisionInput = {
    surface: "public_tenant",
    routeKind,
    pathname: result.currentPath,
    tenant: buildSeoTenantInputFromContext(result.tenant),
    siteVisibility: result.shell.site.siteVisibility,
    resourceState: "published",
    resourceSeo: {
      noindex: Boolean(pageSeo?.noindex),
      nofollow: Boolean(pageSeo?.nofollow),
      ...(rawSchemaType ? { schemaType: rawSchemaType as never } : {}),
    },
  };

  const schemaRes = generateSchemaGraph({
    seo: seoInput,
    tenantId: result.tenant.id,
    siteName: result.shell.site.title,
    siteTagline: result.shell.site.tagline,
    locale: result.shell.site.locale,
    timezone: result.shell.site.timezone,
    business: buildEnrichedSchemaBusinessProfile({
      shell: result.shell,
      seoCtx,
      includeVisibleBranches,
    }),
    pageTitle: result.pageTitle,
    pageDescription: result.seoMetadata.description,
    pageSchemaType: rawSchemaType,
    breadcrumbs: result.isHomepage ? null : toSchemaBreadcrumbs(result.breadcrumbs),
    faqItems,
    allowedMediaOrigins: deps.mediaPublicBaseUrl ? [deps.mediaPublicBaseUrl] : undefined,
  });

  const schemaGraph = schemaRes.graph ?? result.schemaGraph;
  return {
    head: buildHeadPropsFromSeoContext({
      metadata: result.seoMetadata,
      schemaGraph,
      shell: result.shell,
      seoCtx,
      templateValues: {
        routeKind,
        title: result.pageTitle,
        tagline: result.shell.site.tagline,
        excerpt: result.seoMetadata.description,
        hasTitleOverride,
        hasDescriptionOverride,
      },
    }),
    activeBranches,
    shouldRenderStandaloneBranches,
    schemaGraph,
  };
}

/**
 * Enriches `/blog/[slug]` with:
 * - Guaranteed H2/H3 anchor `id` injection matching the server-rendered TOC 1:1 (zero JS)
 * - Full Public Author Profile (`authors` table: bio <= 300, verified avatar, up to 5 `sameAs` links)
 * - Clickable published category & tag archive links (`/blog/category/[slug]`, `/blog/tag/[slug]`)
 * - Unified Schema.org `@graph` with rich `Person` author (`description`, `image`, `sameAs`)
 */
export async function enrichPublicBlogDetailResult(
  result: PublicBlogDetailRenderResult,
  deps: PublicRouteDeps,
): Promise<EnrichedPublicBlogDetailData> {
  const tenantDb = resolveTenantDbFromDeps(deps, result.tenant.id);
  const [seoCtx, publishedPaths] = await Promise.all([
    loadPublicSeoCtxSafe(deps, result.tenant.id),
    tenantDb ? loadPublishedTenantInternalLinkTargets(tenantDb).catch(() => null) : Promise.resolve(null),
  ]);

  // Inject deterministic heading IDs into sanitized HTML for 100% zero-JS TOC jump links,
  // then enforce published-target & internal-link hygiene so draft/unpublished/forbidden links
  // are never rendered as live broken anchors.
  const anchored = injectTocHeadingAnchors(result.post.sanitizedHtml);
  const sanitizedHtmlWithAnchors = sanitizeHtmlInternalLinks(anchored.html, {
    verifiedOrigin: result.primaryOrigin,
    publishedPaths,
  });
  const showToc = result.post.showToc && anchored.toc.length > 0;

  let authorProfile: PublicAuthorProfileDto | null = result.post.authorName
    ? {
        name: result.post.authorName,
        bio: normalizeAuthorBio(result.post.authorBio),
        avatar: null,
        sameAs: [],
      }
    : null;
  const categoryLinks: PublishedTaxonomyChipLink[] = [];
  const tagLinks: PublishedTaxonomyChipLink[] = [];
  let storedSchemaType: string | null = null;
  let hasTitleOverride = false;
  let hasDescriptionOverride = false;
  let postNoindex = false;
  let postNofollow = false;

  if (tenantDb) {
    try {
      const postRow = await tenantDb
        .prepare(
          `SELECT id, author_id, primary_category_id, published_body_json
           FROM posts
           WHERE slug = ? AND status = 'published' AND deleted_at IS NULL
           LIMIT 1`,
        )
        .bind(result.post.slug)
        .first<{
          readonly id: number;
          readonly author_id: number | null;
          readonly primary_category_id: number | null;
          readonly published_body_json: string | null;
        }>();

      let snapAuthorId = postRow?.author_id ?? null;
      const catIds = new Set<number>();
      const tagIds = new Set<number>();

      if (postRow?.published_body_json) {
        try {
          const env = JSON.parse(postRow.published_body_json) as {
            readonly data?: {
              readonly authorId?: number | null;
              readonly primaryCategoryId?: number | null;
              readonly categoryIds?: readonly number[];
              readonly tagIds?: readonly number[];
              readonly seo?: Record<string, unknown>;
            };
          };
          const d = env.data;
          if (typeof d?.authorId === "number") snapAuthorId = d.authorId;
          if (typeof d?.primaryCategoryId === "number") catIds.add(d.primaryCategoryId);
          for (const cid of d?.categoryIds ?? []) catIds.add(cid);
          for (const tid of d?.tagIds ?? []) tagIds.add(tid);
          if (d?.seo) {
            if (typeof d.seo.schemaType === "string") storedSchemaType = d.seo.schemaType;
            hasTitleOverride = Boolean(
              (typeof d.seo.titleOverride === "string" && d.seo.titleOverride.trim()) ||
                (typeof d.seo.seoTitle === "string" && d.seo.seoTitle.trim()),
            );
            hasDescriptionOverride = Boolean(
              (typeof d.seo.descriptionOverride === "string" && d.seo.descriptionOverride.trim()) ||
                (typeof d.seo.seoDescription === "string" && d.seo.seoDescription.trim()),
            );
            postNoindex = Boolean(d.seo.noindex);
            postNofollow = Boolean(d.seo.nofollow);
          }
        } catch {
          // Ignore malformed envelope
        }
      }

      if (snapAuthorId) {
        const dbAuthor = await getPublicAuthorById(tenantDb, snapAuthorId, {
          tenantId: result.tenant.id,
          mediaBaseOrigin: deps.mediaPublicBaseUrl ?? null,
        });
        if (dbAuthor) {
          authorProfile = {
            id: dbAuthor.id,
            name: result.post.authorName || dbAuthor.name,
            slug: dbAuthor.slug,
            bio: dbAuthor.bio ?? normalizeAuthorBio(result.post.authorBio),
            avatar: dbAuthor.avatar,
            sameAs: dbAuthor.sameAs,
          };
        }
      }

      const allTaxIds = Array.from(new Set([...catIds, ...tagIds])).filter(
        (id) => Number.isSafeInteger(id) && id >= 1,
      );
      if (allTaxIds.length > 0) {
        const placeholders = allTaxIds.map(() => "?").join(", ");
        const taxRows = await tenantDb
          .prepare(
            `SELECT id, taxonomy_type, slug, name FROM taxonomies WHERE id IN (${placeholders})`,
          )
          .bind(...allTaxIds)
          .all<{
            readonly id: number;
            readonly taxonomy_type: string;
            readonly slug: string;
            readonly name: string;
          }>();
        const byId = new Map(taxRows.results.map((r) => [Number(r.id), r]));
        const seenCatSlugs = new Set<string>();
        const seenTagSlugs = new Set<string>();
        if (result.shell.site.blogEnabled) {
          for (const cid of catIds) {
            const row = byId.get(cid);
            if (!row || row.taxonomy_type !== "post_category") continue;
            const slug = row.slug.toLowerCase();
            const href = `/blog/category/${slug}`;
            if (seenCatSlugs.has(slug)) continue;
            if (publishedPaths && !publishedPaths.has(href)) continue;
            const checked = sanitizeTenantLocalHref(href, {
              verifiedOrigin: result.primaryOrigin,
              publishedPaths,
              requireLocal: true,
            });
            if (!checked.ok || !checked.href) continue;
            seenCatSlugs.add(slug);
            categoryLinks.push({
              name: row.name,
              slug,
              href: checked.href,
            });
          }
          for (const tid of tagIds) {
            const row = byId.get(tid);
            if (!row || row.taxonomy_type !== "post_tag") continue;
            const slug = row.slug.toLowerCase();
            const href = `/blog/tag/${slug}`;
            if (seenTagSlugs.has(slug)) continue;
            if (publishedPaths && !publishedPaths.has(href)) continue;
            const checked = sanitizeTenantLocalHref(href, {
              verifiedOrigin: result.primaryOrigin,
              publishedPaths,
              requireLocal: true,
            });
            if (!checked.ok || !checked.href) continue;
            seenTagSlugs.add(slug);
            tagLinks.push({
              name: row.name,
              slug,
              href: checked.href,
            });
          }
        }
      }
    } catch {
      // Fall back cleanly to base result
    }
  }

  const authorAvatarSchema: SchemaImageInput | null = authorProfile?.avatar
    ? {
        url: authorProfile.avatar.url,
        width: authorProfile.avatar.width,
        height: authorProfile.avatar.height,
        alt: authorProfile.avatar.alt,
        tenantId: result.tenant.id,
        status: "ready",
      }
    : null;

  const coverSchema: SchemaImageInput | null = result.post.coverImage
    ? {
        url: result.post.coverImage.url,
        width: result.post.coverImage.width,
        height: result.post.coverImage.height,
        alt: result.post.coverImage.alt,
        tenantId: result.tenant.id,
        status: "ready",
      }
    : null;

  const articleInput: SchemaArticleInput = {
    schemaType: storedSchemaType ?? "BlogPosting",
    headline: result.post.title,
    description: result.post.excerpt ?? result.seoMetadata.description,
    datePublished: result.post.publishedAtIso,
    dateModified: result.post.modifiedAtIso,
    authorName: authorProfile?.name ?? result.post.authorName,
    authorBio: authorProfile?.bio ?? null,
    authorAvatar: authorAvatarSchema,
    authorSameAs: authorProfile?.sameAs ?? null,
    image: coverSchema,
    section: result.post.categoryName,
    tags: result.post.tagNames,
    inLanguage: result.shell.site.locale,
  };

  const schemaRes = generateSchemaGraph({
    seo: {
      surface: "public_tenant",
      routeKind: "post",
      pathname: result.currentPath,
      tenant: buildSeoTenantInputFromContext(result.tenant),
      siteVisibility: result.shell.site.siteVisibility,
      resourceState: "published",
      resourceSeo: {
        noindex: postNoindex,
        nofollow: postNofollow,
        ...(storedSchemaType ? { schemaType: storedSchemaType as never } : {}),
      },
    },
    tenantId: result.tenant.id,
    siteName: result.shell.site.title,
    siteTagline: result.shell.site.tagline,
    locale: result.shell.site.locale,
    timezone: result.shell.site.timezone,
    business: buildEnrichedSchemaBusinessProfile({
      shell: result.shell,
      seoCtx,
      includeVisibleBranches: false,
    }),
    pageTitle: result.post.title,
    pageDescription: result.seoMetadata.description,
    breadcrumbs: toSchemaBreadcrumbs(result.breadcrumbs),
    article: articleInput,
    allowedMediaOrigins: deps.mediaPublicBaseUrl ? [deps.mediaPublicBaseUrl] : undefined,
  });

  const blogIndexChecked = result.shell.site.blogEnabled
    ? sanitizeTenantLocalHref("/blog", {
        verifiedOrigin: result.primaryOrigin,
        publishedPaths,
        requireLocal: true,
      })
    : { ok: false, href: null, reason: "blog_disabled" };
  const blogIndexHref = blogIndexChecked.ok ? blogIndexChecked.href : null;

  const catalogCta = resolvePublishedCatalogCta({
    catalogEnabled: result.shell.site.catalogEnabled,
    verifiedOrigin: result.primaryOrigin,
    publishedPaths,
  });

  const validatedRelatedPosts: PublicBlogListItem[] = [];
  for (const rel of result.relatedPosts) {
    const checked = sanitizeTenantLocalHref(rel.href, {
      verifiedOrigin: result.primaryOrigin,
      publishedPaths,
      requireLocal: true,
    });
    if (checked.ok && checked.href) {
      validatedRelatedPosts.push({ ...rel, href: checked.href });
    }
  }

  const schemaGraph = schemaRes.graph ?? result.schemaGraph;
  return {
    head: buildHeadPropsFromSeoContext({
      metadata: result.seoMetadata,
      schemaGraph,
      shell: result.shell,
      seoCtx,
      templateValues: {
        routeKind: "post",
        title: result.post.title,
        tagline: result.shell.site.tagline,
        category: result.post.categoryName,
        excerpt: result.post.excerpt ?? result.seoMetadata.description,
        hasTitleOverride,
        hasDescriptionOverride,
      },
    }),
    sanitizedHtmlWithAnchors,
    toc: anchored.toc,
    showToc,
    authorProfile,
    categoryLinks,
    tagLinks,
    blogIndexHref,
    catalogCta,
    validatedRelatedPosts,
    schemaGraph,
  };
}

/**
 * Enriches `/blog` listing with published SEO autopilot context, structured business profile,
 * verification tags, and RSS discovery link.
 */
export async function enrichPublicBlogListingResult(
  result: PublicBlogListingRenderResult,
  deps: PublicRouteDeps,
): Promise<EnrichedPublicListingData> {
  const seoCtx = await loadPublicSeoCtxSafe(deps, result.tenant.id);
  const seoQuery = new URLSearchParams();
  if (result.pagination.page > 1) seoQuery.set("page", String(result.pagination.page));

  const schemaRes = generateSchemaGraph({
    seo: {
      surface: "public_tenant",
      routeKind: "blog_index",
      pathname: "/blog",
      query: seoQuery,
      tenant: buildSeoTenantInputFromContext(result.tenant),
      siteVisibility: result.shell.site.siteVisibility,
      resourceState: "published",
      archiveEnabled: true,
      publishedItemCount: result.pagination.totalItems,
      totalPages: result.pagination.totalPages,
    },
    tenantId: result.tenant.id,
    siteName: result.shell.site.title,
    siteTagline: result.shell.site.tagline,
    locale: result.shell.site.locale,
    timezone: result.shell.site.timezone,
    business: buildEnrichedSchemaBusinessProfile({
      shell: result.shell,
      seoCtx,
      includeVisibleBranches: false,
    }),
    pageTitle: result.pageTitle,
    pageDescription: result.description,
    breadcrumbs: toSchemaBreadcrumbs(result.breadcrumbs),
    allowedMediaOrigins: deps.mediaPublicBaseUrl ? [deps.mediaPublicBaseUrl] : undefined,
  });

  const schemaGraph = schemaRes.graph ?? result.schemaGraph;
  return {
    head: buildHeadPropsFromSeoContext({
      metadata: result.seoMetadata,
      schemaGraph,
      shell: result.shell,
      seoCtx,
      templateValues: {
        routeKind: "blog_index",
        title: result.heading,
        tagline: result.shell.site.tagline,
        excerpt: result.description,
        pageNumber: result.pagination.page,
      },
    }),
    schemaGraph,
  };
}

/**
 * Enriches offering listing pages (`/layanan`, `/produk`, `/tour`, `/kendaraan`).
 */
export async function enrichPublicOfferingListingResult(
  result: PublicOfferingListingRenderResult,
  deps: PublicRouteDeps,
): Promise<EnrichedPublicListingData> {
  const seoCtx = await loadPublicSeoCtxSafe(deps, result.tenant.id);
  const seoQuery = new URLSearchParams();
  if (result.pagination.page > 1) seoQuery.set("page", String(result.pagination.page));

  const schemaRes = generateSchemaGraph({
    seo: {
      surface: "public_tenant",
      routeKind: "catalog_index",
      pathname: result.descriptor.prefix,
      query: seoQuery,
      tenant: buildSeoTenantInputFromContext(result.tenant),
      siteVisibility: result.shell.site.siteVisibility,
      resourceState: "published",
      archiveEnabled: true,
      publishedItemCount: result.pagination.totalItems,
      totalPages: result.pagination.totalPages,
    },
    tenantId: result.tenant.id,
    siteName: result.shell.site.title,
    siteTagline: result.shell.site.tagline,
    locale: result.shell.site.locale,
    timezone: result.shell.site.timezone,
    business: buildEnrichedSchemaBusinessProfile({
      shell: result.shell,
      seoCtx,
      includeVisibleBranches: false,
    }),
    pageTitle: result.pageTitle,
    pageDescription: result.descriptor.listingDescription,
    breadcrumbs: toSchemaBreadcrumbs(result.breadcrumbs),
    allowedMediaOrigins: deps.mediaPublicBaseUrl ? [deps.mediaPublicBaseUrl] : undefined,
  });

  const schemaGraph = schemaRes.graph ?? result.schemaGraph;
  return {
    head: buildHeadPropsFromSeoContext({
      metadata: result.seoMetadata,
      schemaGraph,
      shell: result.shell,
      seoCtx,
      templateValues: {
        routeKind: "catalog_index",
        title: result.descriptor.listingHeading,
        tagline: result.shell.site.tagline,
        excerpt: result.descriptor.listingDescription,
        pageNumber: result.pagination.page,
      },
    }),
    schemaGraph,
  };
}

/**
 * Enriches offering detail pages (`/{layanan|produk|tour|kendaraan}/[slug]`) with
 * clickable published category archive links, structured business profile, and
 * `resolvePublishSafeSchemaType`-gated Schema.org `@graph`.
 */
export async function enrichPublicOfferingDetailResult(
  result: PublicOfferingDetailRenderResult,
  deps: PublicRouteDeps,
): Promise<EnrichedPublicOfferingDetailData> {
  const tenantDb = resolveTenantDbFromDeps(deps, result.tenant.id);
  const [seoCtx, publishedPaths] = await Promise.all([
    loadPublicSeoCtxSafe(deps, result.tenant.id),
    tenantDb ? loadPublishedTenantInternalLinkTargets(tenantDb).catch(() => null) : Promise.resolve(null),
  ]);
  const categoryLinks: PublishedTaxonomyChipLink[] = [];
  const sanitizedDescriptionHtml = result.offering.descriptionHtml
    ? sanitizeHtmlInternalLinks(result.offering.descriptionHtml, {
        verifiedOrigin: result.primaryOrigin,
        publishedPaths,
      })
    : null;

  let storedSchemaType: string | null = null;
  let hasTitleOverride = false;
  let hasDescriptionOverride = false;
  let itemNoindex = false;
  let itemNofollow = false;
  let price: number | null = null;
  let priceMax: number | null = null;

  if (tenantDb) {
    try {
      const row = await tenantDb
        .prepare(
          `SELECT published_snapshot_json FROM offerings
           WHERE offering_type = ? AND slug = ? AND status = 'published' AND deleted_at IS NULL
           LIMIT 1`,
        )
        .bind(result.offering.offeringType, result.offering.slug)
        .first<{ readonly published_snapshot_json: string | null }>();

      const catIds = new Set<number>();
      if (row?.published_snapshot_json) {
        const env = JSON.parse(row.published_snapshot_json) as {
          readonly data?: {
            readonly categoryIds?: readonly number[];
            readonly price?: number | null;
            readonly priceMax?: number | null;
            readonly seo?: Record<string, unknown>;
          };
        };
        const d = env.data;
        if (typeof d?.price === "number") price = d.price;
        if (typeof d?.priceMax === "number") priceMax = d.priceMax;
        for (const cid of d?.categoryIds ?? []) catIds.add(cid);
        if (d?.seo) {
          if (typeof d.seo.schemaType === "string") storedSchemaType = d.seo.schemaType;
          hasTitleOverride = Boolean(
            (typeof d.seo.titleOverride === "string" && d.seo.titleOverride.trim()) ||
              (typeof d.seo.seoTitle === "string" && d.seo.seoTitle.trim()),
          );
          hasDescriptionOverride = Boolean(
            (typeof d.seo.descriptionOverride === "string" && d.seo.descriptionOverride.trim()) ||
              (typeof d.seo.seoDescription === "string" && d.seo.seoDescription.trim()),
          );
          itemNoindex = Boolean(d.seo.noindex);
          itemNofollow = Boolean(d.seo.nofollow);
        }
      }

      const ids = Array.from(catIds).filter((id) => Number.isSafeInteger(id) && id >= 1);
      if (ids.length > 0 && result.shell.site.catalogEnabled) {
        const placeholders = ids.map(() => "?").join(", ");
        const taxRows = await tenantDb
          .prepare(
            `SELECT id, slug, name, offering_type FROM taxonomies
             WHERE id IN (${placeholders}) AND taxonomy_type = 'offering_category'`,
          )
          .bind(...ids)
          .all<{
            readonly id: number;
            readonly slug: string;
            readonly name: string;
            readonly offering_type: string | null;
          }>();
        const byId = new Map(taxRows.results.map((r) => [Number(r.id), r]));
        const seen = new Set<string>();
        for (const cid of ids) {
          const t = byId.get(cid);
          if (!t) continue;
          if (t.offering_type !== null && t.offering_type !== result.offering.offeringType) continue;
          const slug = t.slug.toLowerCase();
          const href = `${result.descriptor.prefix}/category/${slug}`;
          if (seen.has(slug)) continue;
          if (publishedPaths && !publishedPaths.has(href)) continue;
          const checked = sanitizeTenantLocalHref(href, {
            verifiedOrigin: result.primaryOrigin,
            publishedPaths,
            requireLocal: true,
          });
          if (!checked.ok || !checked.href) continue;
          seen.add(slug);
          categoryLinks.push({
            name: t.name,
            slug,
            href: checked.href,
          });
        }
      }
    } catch {
      // Graceful fallback
    }
  }

  const schemaImages: SchemaImageInput[] = [
    result.offering.coverImage,
    ...result.offering.galleryImages,
  ]
    .filter((img): img is NonNullable<typeof img> => Boolean(img))
    .map((img) => ({
      url: img.url,
      width: img.width,
      height: img.height,
      alt: img.alt,
      tenantId: result.tenant.id,
      status: "ready",
    }));

  const offeringSchemaInput: SchemaOfferingInput = {
    offeringType: result.offering.offeringType,
    title: result.offering.title,
    summary: result.offering.summary,
    priceMode: result.offering.priceMode,
    price,
    priceMax,
    negotiable: result.offering.negotiable,
    ctaMode: result.offering.cta.mode,
    unitStatus: result.offering.unitStatus,
    categoryName: result.offering.categoryNames[0] ?? null,
    images: schemaImages,
    attributes:
      result.offering.serviceAttributes ??
      result.offering.productAttributes ??
      result.offering.tourAttributes ??
      result.offering.vehicleAttributes ??
      result.offering.attributes,
  };

  const schemaRes = generateSchemaGraph({
    seo: {
      surface: "public_tenant",
      routeKind: "offering",
      pathname: result.currentPath,
      tenant: buildSeoTenantInputFromContext(result.tenant),
      siteVisibility: result.shell.site.siteVisibility,
      resourceState: "published",
      resourceSeo: {
        noindex: itemNoindex,
        nofollow: itemNofollow,
        ...(storedSchemaType ? { schemaType: storedSchemaType as never } : {}),
      },
    },
    tenantId: result.tenant.id,
    siteName: result.shell.site.title,
    siteTagline: result.shell.site.tagline,
    locale: result.shell.site.locale,
    timezone: result.shell.site.timezone,
    business: buildEnrichedSchemaBusinessProfile({
      shell: result.shell,
      seoCtx,
      includeVisibleBranches: false,
    }),
    pageTitle: result.offering.title,
    pageDescription: result.seoMetadata.description,
    breadcrumbs: toSchemaBreadcrumbs(result.breadcrumbs),
    offering: offeringSchemaInput,
    now: deps.nowMs,
    allowedMediaOrigins: deps.mediaPublicBaseUrl ? [deps.mediaPublicBaseUrl] : undefined,
  });

  const schemaGraph = schemaRes.graph ?? result.schemaGraph;
  return {
    head: buildHeadPropsFromSeoContext({
      metadata: result.seoMetadata,
      schemaGraph,
      shell: result.shell,
      seoCtx,
      templateValues: {
        routeKind: "offering",
        title: result.offering.title,
        tagline: result.shell.site.tagline,
        category: result.offering.categoryNames[0] ?? result.descriptor.singularLabel,
        excerpt: result.offering.summary ?? result.seoMetadata.description,
        hasTitleOverride,
        hasDescriptionOverride,
      },
    }),
    sanitizedDescriptionHtml,
    categoryLinks,
    schemaGraph,
  };
}

/**
 * Enriches blog category/tag archive pages (`/blog/category/[slug]`, `/blog/tag/[slug]`).
 */
export async function enrichPublicBlogTaxonomyArchiveResult(
  result: PublicBlogTaxonomyArchiveRenderResult,
  deps: PublicRouteDeps,
): Promise<EnrichedPublicListingData> {
  const seoCtx = await loadPublicSeoCtxSafe(deps, result.tenant.id);
  const routeKind: SeoRouteKind =
    result.taxonomyKind === "post_category" ? "category_archive" : "tag_archive";
  const basePath =
    result.taxonomyKind === "post_category"
      ? `/blog/category/${result.taxonomy.slug}`
      : `/blog/tag/${result.taxonomy.slug}`;
  const seoQuery = new URLSearchParams();
  if (result.pagination.page > 1) seoQuery.set("page", String(result.pagination.page));

  const schemaRes = generateSchemaGraph({
    seo: {
      surface: "public_tenant",
      routeKind,
      pathname: basePath,
      query: seoQuery,
      tenant: buildSeoTenantInputFromContext(result.tenant),
      siteVisibility: result.shell.site.siteVisibility,
      resourceState: "published",
      archiveEnabled: true,
      publishedItemCount: result.pagination.totalItems,
      totalPages: result.pagination.totalPages,
      taxonomyIndexOptIn: result.taxonomy.indexOptIn,
      taxonomyHasUsefulIntro: result.taxonomy.hasUsefulIntro,
    },
    tenantId: result.tenant.id,
    siteName: result.shell.site.title,
    siteTagline: result.shell.site.tagline,
    locale: result.shell.site.locale,
    timezone: result.shell.site.timezone,
    business: buildEnrichedSchemaBusinessProfile({
      shell: result.shell,
      seoCtx,
      includeVisibleBranches: false,
    }),
    pageTitle: result.pageTitle,
    pageDescription: result.seoMetadata.description,
    breadcrumbs: toSchemaBreadcrumbs(result.breadcrumbs),
    allowedMediaOrigins: deps.mediaPublicBaseUrl ? [deps.mediaPublicBaseUrl] : undefined,
  });

  const schemaGraph = schemaRes.graph ?? result.schemaGraph;
  return {
    head: buildHeadPropsFromSeoContext({
      metadata: result.seoMetadata,
      schemaGraph,
      shell: result.shell,
      seoCtx,
      templateValues: {
        routeKind,
        title: result.taxonomy.name,
        tagline: result.shell.site.tagline,
        excerpt: result.taxonomy.description ?? result.seoMetadata.description,
        pageNumber: result.pagination.page,
      },
    }),
    schemaGraph,
  };
}

/**
 * Enriches offering category archive pages (`/{layanan|produk|tour|kendaraan}/category/[slug]`).
 */
export async function enrichPublicOfferingCategoryArchiveResult(
  result: PublicOfferingCategoryArchiveRenderResult,
  deps: PublicRouteDeps,
): Promise<EnrichedPublicListingData> {
  const seoCtx = await loadPublicSeoCtxSafe(deps, result.tenant.id);
  const basePath = `${result.descriptor.prefix}/category/${result.taxonomy.slug}`;
  const seoQuery = new URLSearchParams();
  if (result.pagination.page > 1) seoQuery.set("page", String(result.pagination.page));

  const schemaRes = generateSchemaGraph({
    seo: {
      surface: "public_tenant",
      routeKind: "offering_category_archive",
      pathname: basePath,
      query: seoQuery,
      tenant: buildSeoTenantInputFromContext(result.tenant),
      siteVisibility: result.shell.site.siteVisibility,
      resourceState: "published",
      archiveEnabled: true,
      publishedItemCount: result.pagination.totalItems,
      totalPages: result.pagination.totalPages,
      taxonomyIndexOptIn: result.taxonomy.indexOptIn,
      taxonomyHasUsefulIntro: result.taxonomy.hasUsefulIntro,
    },
    tenantId: result.tenant.id,
    siteName: result.shell.site.title,
    siteTagline: result.shell.site.tagline,
    locale: result.shell.site.locale,
    timezone: result.shell.site.timezone,
    business: buildEnrichedSchemaBusinessProfile({
      shell: result.shell,
      seoCtx,
      includeVisibleBranches: false,
    }),
    pageTitle: result.pageTitle,
    pageDescription: result.seoMetadata.description,
    breadcrumbs: toSchemaBreadcrumbs(result.breadcrumbs),
    allowedMediaOrigins: deps.mediaPublicBaseUrl ? [deps.mediaPublicBaseUrl] : undefined,
  });

  const schemaGraph = schemaRes.graph ?? result.schemaGraph;
  return {
    head: buildHeadPropsFromSeoContext({
      metadata: result.seoMetadata,
      schemaGraph,
      shell: result.shell,
      seoCtx,
      templateValues: {
        routeKind: "offering_category_archive",
        title: result.taxonomy.name,
        tagline: result.shell.site.tagline,
        excerpt: result.taxonomy.description ?? result.seoMetadata.description,
        pageNumber: result.pagination.page,
      },
    }),
    schemaGraph,
  };
}
