/**
 * TASK-054 Cloudflare `workerd` Two-Tenant HTTP Crawl Regression Suite (`REQ-055`, `PLAN.md §15`).
 *
 * Scope & Runtime Architecture:
 * - Executes the REAL request middleware gate (`executeTenantMiddleware`), real edge-cache
 *   lookup/store (`serveWithTenantEdgeCache`), real discovery HTTP handlers (`/robots.txt`,
 *   `/sitemap.xml`, `/sitemaps/[kind].xml`, `/blog/feed.xml`), real public route resolvers
 *   (`resolvePublicPageRoute`, `resolveBlog*`, `resolveOffering*`, `resolve*ArchiveRoute`),
 *   real head/schema enrichers, and `composePublicSeoHead` in-process on `workerd` backed by
 *   real `PLATFORM_DB` D1 + two isolated `TenantStore` Durable Objects.
 * - Full Astro `.astro` component compilation + Playwright Chromium No-JS DOM rendering checks
 *   at 360px & 1440px run in `tests/task-054/e2e.mjs`.
 * - Every test resets mutable platform host/status state and uses an isolated edge cache so
 *   cases are independent and safe to run via `it.only` or in any order.
 */

import { env } from "cloudflare:workers";
import { getOfferingPublicPath } from "@punyasitus/core/catalog/index";
import { composePublicSeoHead } from "@punyasitus/core/seo/local-entity";
import { isPathAllowedByRobotsTxt } from "@punyasitus/core/seo/robots";
import { createPublicAuthor } from "@punyasitus/db/authors/index";
import { createBranch } from "@punyasitus/db/branches/index";
import { BRANCHES_MIGRATION } from "@punyasitus/db/branches/migrations";
import {
  publishStructuredBusinessProfile,
  saveStructuredBusinessProfileDraft,
} from "@punyasitus/db/business-profile/index";
import { BUSINESS_PROFILE_STRUCTURED_MIGRATION } from "@punyasitus/db/business-profile/migrations";
import {
  createCatalogCategory,
  createCatalogOffering,
  publishCatalogOffering,
} from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  createPage,
  publishPage,
  trashPage,
  updatePage,
} from "@punyasitus/db/pages/index";
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import {
  createPost,
  publishPost,
  updatePost,
} from "@punyasitus/db/posts/index";
import { bumpTenantCacheVersion } from "@punyasitus/db/publication/index";
import { clearHostResolutionCache } from "@punyasitus/db/routing/index";
import {
  getTenantSeoEditorSettings,
  publishTenantSeoEditorSettings,
  recordExternalVerificationCheck,
  saveTenantSeoEditorSettingsDraft,
  TENANT_0013_SEO_EDITOR_SETTINGS_MIGRATION,
} from "@punyasitus/db/seo/index";
import { createTaxonomy } from "@punyasitus/db/taxonomy/index";
import { TAXONOMY_ARCHIVE_SETTINGS_MIGRATION } from "@punyasitus/db/taxonomy/migrations";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  enrichPublicBlogDetailResult,
  enrichPublicBlogListingResult,
  enrichPublicBlogTaxonomyArchiveResult,
  enrichPublicOfferingCategoryArchiveResult,
  enrichPublicOfferingDetailResult,
  enrichPublicOfferingListingResult,
  enrichPublicPageRouteResult,
} from "../../apps/web/src/components/seo/public-seo-context.ts";
import { CACHE_VERSION_HEADER_NAME } from "../../apps/web/src/core/cache.ts";
import {
  resolveBlogDetailRoute,
  resolveBlogListingRoute,
  resolveOfferingDetailRoute,
  resolveOfferingListingRoute,
  resolvePublicPageRoute,
  type PublicBreadcrumbItem,
  type PublicRouteDeps,
} from "../../apps/web/src/core/public-routes.ts";
import {
  executeTenantMiddleware,
  type TenantMiddlewareLocals,
} from "../../apps/web/src/core/tenant.ts";
import { buildPublicThemeRouteShellContract } from "../../apps/web/src/core/theme-registry.ts";
import {
  resolveBlogCategoryArchiveRoute,
  resolveBlogTagArchiveRoute,
  resolveOfferingCategoryArchiveRoute,
} from "../../apps/web/src/pages/blog/category/_archive-resolver.ts";
import {
  handleBlogFeedRequest,
  handleRobotsTxtRequest,
  handleSitemapIndexRequest,
  handleSubSitemapRequest,
  type DiscoveryHandlerDeps,
} from "../../apps/web/src/pages/sitemaps/_shared.ts";
import { SAMPLE_AGENCY_THEME_ID } from "../../apps/web/src/themes/custom/sample-agency/theme.ts";
import {
  auditHttpCrawlPage,
  auditInternalLinksOverHttp,
  auditSitemapIndexXml,
  auditUrlsetXml,
  findCrossTenantLeaks,
  parseRobotsTxt,
  parseStrictCrawlXml,
} from "./crawl-audit.ts";

const BASE_TIME = 1_870_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_A = {
  id: "01JT054ALPHA00000000000001",
  orgId: "org_t054_alpha",
  handle: "t054-alpha",
  name: "PT Alpha Arsitektur Mandiri",
  subdomain: "t054-alpha.situsku.click",
  customDomain: "www.t054-alpha.id",
  draftSecret: "ALPHA_DRAFT_SECRET_SENTINEL_2026",
  draftToken: "DEADBEEF000011112222333344445555",
} as const;

const TENANT_B = {
  id: "01JT054BETA000000000000002",
  orgId: "org_t054_beta",
  handle: "t054-beta",
  name: "Beta Klinik Trial Terisolasi",
  subdomain: "t054-beta.situsku.click",
  secretSentinel: "BETA_TENANT_ISOLATION_SENTINEL_99",
} as const;

function createInMemoryEdgeCache(): Cache {
  const store = new Map<string, Response>();
  return {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const key =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      const found = store.get(key);
      return found ? found.clone() : undefined;
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      const key =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      store.set(key, response.clone());
    },
    async delete(request: RequestInfo | URL): Promise<boolean> {
      const key =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      return store.delete(key);
    },
  } as unknown as Cache;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBreadcrumbsNav(items: readonly PublicBreadcrumbItem[]): string {
  return items
    .filter((b): b is PublicBreadcrumbItem & { readonly href: string } => Boolean(b.href))
    .map((b) => `<a href="${escapeHtml(b.href)}">${escapeHtml(b.label)}</a>`)
    .join("");
}

function renderShellMenuNav(
  menus: {
    readonly header: ReadonlyArray<{ readonly href: string; readonly label: string }>;
    readonly footer: ReadonlyArray<{ readonly href: string; readonly label: string }>;
  },
): string {
  const all = [...menus.header, ...menus.footer];
  return all.map((m) => `<a href="${escapeHtml(m.href)}">${escapeHtml(m.label)}</a>`).join("");
}

function renderHtmlDocument(params: {
  readonly headHtml: string;
  readonly h1: string;
  readonly bodyHtml: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}): Response {
  const html =
    `<!doctype html><html lang="id"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />${params.headHtml}</head>` +
    `<body><main><h1>${escapeHtml(params.h1)}</h1>${params.bodyHtml}</main></body></html>`;
  return new Response(html, {
    status: params.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...params.headers,
    },
  });
}

/**
 * In-process two-tenant HTTP request dispatcher wiring real `executeTenantMiddleware`,
 * isolated edge cache, real discovery endpoints, real public route resolvers (emitting
 * links strictly from resolver outputs: menus, breadcrumbs, items, pagination, categories,
 * tags, sections, and sanitized body HTML), and `composePublicSeoHead`.
 */
function createLiveCrawlFetcher(options: {
  readonly cache?: Cache;
  readonly nowMs?: number;
  readonly maxUrlsPerSitemap?: number;
} = {}) {
  const nowMs = options.nowMs ?? BASE_TIME;
  const edgeCache = options.cache ?? createInMemoryEdgeCache();

  return async function crawlFetch(
    urlStr: string,
    init?: { readonly method?: string; readonly headers?: Record<string, string> },
  ): Promise<Response> {
    const request = new Request(urlStr, {
      method: init?.method ?? "GET",
      headers: init?.headers,
    });
    const locals: TenantMiddlewareLocals = {
      surface: "unknown",
      host: "",
      isLocalLoopback: false,
      tenant: null,
      tenantDb: null,
    };

    return executeTenantMiddleware(
      { request, locals },
      async () => {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const routeDeps: PublicRouteDeps = {
          surface: locals.surface,
          host: locals.host,
          tenant: locals.tenant,
          tenantDb: locals.tenantDb,
          platformDb: env.PLATFORM_DB,
          tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
          platformDomain: "punyasitus.com",
          saasZone: "situsku.click",
          nowMs,
          bypassHostCache: true,
        };
        const discoveryDeps: DiscoveryHandlerDeps = {
          ...routeDeps,
          maxUrlsPerSitemap: options.maxUrlsPerSitemap,
        };

        // 1. Discovery endpoints
        if (pathname === "/robots.txt") {
          return handleRobotsTxtRequest(request, discoveryDeps);
        }
        if (pathname === "/sitemap.xml") {
          return handleSitemapIndexRequest(request, discoveryDeps);
        }
        const subSitemapMatch = /^\/sitemaps\/([^/]+)\.xml$/i.exec(pathname);
        if (subSitemapMatch) {
          return handleSubSitemapRequest(request, subSitemapMatch[1], discoveryDeps);
        }
        if (pathname === "/blog/feed.xml") {
          return handleBlogFeedRequest(request, discoveryDeps);
        }

        // 2. Blog index, taxonomy archives, and post detail
        if (pathname === "/blog") {
          const res = await resolveBlogListingRoute(request, routeDeps, { url });
          if (res.kind === "response") return res.response;
          if (res.kind === "not_found") {
            const head = composePublicSeoHead({
              metadata: res.seoMetadata,
              schemaGraph: null,
              seoAutopilotEnabled: true,
              blogEnabled: false,
              siteName: res.shell.site.title,
            });
            return renderHtmlDocument({
              headHtml: head.html,
              h1: res.heading,
              bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
              status: res.http.status,
              headers: res.http.headers,
            });
          }
          const enriched = await enrichPublicBlogListingResult(res, routeDeps);
          const head = composePublicSeoHead(enriched.head);
          const links = res.items
            .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a>`)
            .join("");
          const nav = [
            res.pagination.prevHref
              ? `<a rel="prev" href="${escapeHtml(res.pagination.prevHref)}">Prev</a>`
              : "",
            res.pagination.nextHref
              ? `<a rel="next" href="${escapeHtml(res.pagination.nextHref)}">Next</a>`
              : "",
          ].join("");
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.pageTitle,
            bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}</nav><section>${links}</section>${nav}`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }

        const blogCatMatch = /^\/blog\/category\/([^/]+)$/.exec(pathname);
        if (blogCatMatch) {
          const res = await resolveBlogCategoryArchiveRoute(request, routeDeps, blogCatMatch[1]!, {
            url,
          });
          if (res.kind === "response") return res.response;
          if (res.kind === "not_found") {
            const head = composePublicSeoHead({
              metadata: res.seoMetadata,
              schemaGraph: null,
              seoAutopilotEnabled: true,
              blogEnabled: false,
              siteName: res.shell.site.title,
            });
            return renderHtmlDocument({
              headHtml: head.html,
              h1: res.heading,
              bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
              status: res.http.status,
              headers: res.http.headers,
            });
          }
          const enriched = await enrichPublicBlogTaxonomyArchiveResult(res, routeDeps);
          const head = composePublicSeoHead(enriched.head);
          const links = res.items
            .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a>`)
            .join("");
          const nav = [
            res.pagination.prevHref
              ? `<a rel="prev" href="${escapeHtml(res.pagination.prevHref)}">Prev</a>`
              : "",
            res.pagination.nextHref
              ? `<a rel="next" href="${escapeHtml(res.pagination.nextHref)}">Next</a>`
              : "",
          ].join("");
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.pageTitle,
            bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}</nav><section>${links}</section>${nav}`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }

        const blogTagMatch = /^\/blog\/tag\/([^/]+)$/.exec(pathname);
        if (blogTagMatch) {
          const res = await resolveBlogTagArchiveRoute(request, routeDeps, blogTagMatch[1]!, {
            url,
          });
          if (res.kind === "response") return res.response;
          if (res.kind === "not_found") {
            const head = composePublicSeoHead({
              metadata: res.seoMetadata,
              schemaGraph: null,
              seoAutopilotEnabled: true,
              blogEnabled: false,
              siteName: res.shell.site.title,
            });
            return renderHtmlDocument({
              headHtml: head.html,
              h1: res.heading,
              bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
              status: res.http.status,
              headers: res.http.headers,
            });
          }
          const enriched = await enrichPublicBlogTaxonomyArchiveResult(res, routeDeps);
          const head = composePublicSeoHead(enriched.head);
          const links = res.items
            .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a>`)
            .join("");
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.pageTitle,
            bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}</nav><section>${links}</section>`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }

        const blogPostMatch = /^\/blog\/([^/]+)$/.exec(pathname);
        if (blogPostMatch) {
          const res = await resolveBlogDetailRoute(request, routeDeps, blogPostMatch[1]!, { url });
          if (res.kind === "response") return res.response;
          if (res.kind === "not_found") {
            const head = composePublicSeoHead({
              metadata: res.seoMetadata,
              schemaGraph: null,
              seoAutopilotEnabled: true,
              blogEnabled: false,
              siteName: res.shell.site.title,
            });
            return renderHtmlDocument({
              headHtml: head.html,
              h1: res.heading,
              bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
              status: res.http.status,
              headers: res.http.headers,
            });
          }
          const enriched = await enrichPublicBlogDetailResult(res, routeDeps);
          const head = composePublicSeoHead(enriched.head);
          const catLinks = enriched.categoryLinks
            .map((c) => `<a href="${escapeHtml(c.href)}">${escapeHtml(c.name)}</a>`)
            .join("");
          const tagLinks = enriched.tagLinks
            .map((t) => `<a href="${escapeHtml(t.href)}">${escapeHtml(t.name)}</a>`)
            .join("");
          const authorBox = enriched.authorProfile
            ? `<aside data-author="${escapeHtml(enriched.authorProfile.name)}">${escapeHtml(enriched.authorProfile.name)}</aside>`
            : "";
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.post.title,
            bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}${catLinks}${tagLinks}</nav><article>${enriched.sanitizedHtmlWithAnchors}</article>${authorBox}`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }

        // 3. Offering listing, offering category archive, and offering detail
        const offeringPrefixMap = {
          layanan: "service",
          produk: "product",
          tour: "tour",
          kendaraan: "vehicle",
        } as const;

        const offeringCatMatch = /^\/(layanan|produk|tour|kendaraan)\/category\/([^/]+)$/.exec(
          pathname,
        );
        if (offeringCatMatch) {
          const offeringType =
            offeringPrefixMap[offeringCatMatch[1] as keyof typeof offeringPrefixMap];
          const res = await resolveOfferingCategoryArchiveRoute(
            request,
            routeDeps,
            offeringType,
            offeringCatMatch[2]!,
            { url },
          );
          if (res.kind === "response") return res.response;
          if (res.kind === "not_found") {
            const head = composePublicSeoHead({
              metadata: res.seoMetadata,
              schemaGraph: null,
              seoAutopilotEnabled: true,
              blogEnabled: false,
              siteName: res.shell.site.title,
            });
            return renderHtmlDocument({
              headHtml: head.html,
              h1: res.heading,
              bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
              status: res.http.status,
              headers: res.http.headers,
            });
          }
          const enriched = await enrichPublicOfferingCategoryArchiveResult(res, routeDeps);
          const head = composePublicSeoHead(enriched.head);
          const links = res.items
            .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a>`)
            .join("");
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.pageTitle,
            bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}</nav><section>${links}</section>`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }

        const offeringIndexMatch = /^\/(layanan|produk|tour|kendaraan)$/.exec(pathname);
        if (offeringIndexMatch) {
          const offeringType =
            offeringPrefixMap[offeringIndexMatch[1] as keyof typeof offeringPrefixMap];
          const res = await resolveOfferingListingRoute(request, routeDeps, offeringType, { url });
          if (res.kind === "response") return res.response;
          if (res.kind === "not_found") {
            const head = composePublicSeoHead({
              metadata: res.seoMetadata,
              schemaGraph: null,
              seoAutopilotEnabled: true,
              blogEnabled: false,
              siteName: res.shell.site.title,
            });
            return renderHtmlDocument({
              headHtml: head.html,
              h1: res.heading,
              bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
              status: res.http.status,
              headers: res.http.headers,
            });
          }
          const enriched = await enrichPublicOfferingListingResult(res, routeDeps);
          const head = composePublicSeoHead(enriched.head);
          const links = res.items
            .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.title)}</a>`)
            .join("");
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.pageTitle,
            bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}</nav><section>${links}</section>`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }

        const offeringDetailMatch = /^\/(layanan|produk|tour|kendaraan)\/([^/]+)$/.exec(pathname);
        if (offeringDetailMatch) {
          const offeringType =
            offeringPrefixMap[offeringDetailMatch[1] as keyof typeof offeringPrefixMap];
          const res = await resolveOfferingDetailRoute(
            request,
            routeDeps,
            offeringType,
            offeringDetailMatch[2]!,
            { url },
          );
          if (res.kind === "response") return res.response;
          if (res.kind === "not_found") {
            const head = composePublicSeoHead({
              metadata: res.seoMetadata,
              schemaGraph: null,
              seoAutopilotEnabled: true,
              blogEnabled: false,
              siteName: res.shell.site.title,
            });
            return renderHtmlDocument({
              headHtml: head.html,
              h1: res.heading,
              bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
              status: res.http.status,
              headers: res.http.headers,
            });
          }
          const enriched = await enrichPublicOfferingDetailResult(res, routeDeps);
          const head = composePublicSeoHead(enriched.head);
          const catLinks = enriched.categoryLinks
            .map((c) => `<a href="${escapeHtml(c.href)}">${escapeHtml(c.name)}</a>`)
            .join("");
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.offering.title,
            bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}${catLinks}</nav><p>${escapeHtml(res.offering.summary ?? "")}</p>`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }

        // 4. Homepage (`/`) & public pages (`/[...slug]`)
        const slugParam = pathname === "/" ? "" : pathname.replace(/^\/+/, "");
        const res = await resolvePublicPageRoute(request, routeDeps, slugParam, { url });
        if (res.kind === "response") return res.response;
        if (res.kind === "not_found") {
          const head = composePublicSeoHead({
            metadata: res.seoMetadata,
            schemaGraph: null,
            seoAutopilotEnabled: true,
            blogEnabled: false,
            siteName: res.shell.site.title,
          });
          return renderHtmlDocument({
            headHtml: head.html,
            h1: res.heading,
            bodyHtml: `<p>${escapeHtml(res.message)}</p>`,
            status: res.http.status,
            headers: res.http.headers,
          });
        }
        const enriched = await enrichPublicPageRouteResult(res, routeDeps);
        const head = composePublicSeoHead(enriched.head);
        const sectionLinks = (res.page?.sections ?? [])
          .flatMap((sec) => {
            const out: string[] = [];
            if (sec.ctaHref && sec.ctaLabel) {
              out.push(`<a href="${escapeHtml(sec.ctaHref)}">${escapeHtml(sec.ctaLabel)}</a>`);
            }
            if (sec.bodyHtml) out.push(sec.bodyHtml);
            return out;
          })
          .join("");
        const offeringLinks = res.fallbackOfferings
          .map(
            (o) =>
              `<a href="${escapeHtml(getOfferingPublicPath(o.offeringType, o.slug))}">${escapeHtml(o.title)}</a>`,
          )
          .join("");
        const postLinks = res.fallbackPosts
          .map((p) => `<a href="${escapeHtml(`/blog/${p.slug}`)}">${escapeHtml(p.title)}</a>`)
          .join("");
        const branchMarkup = enriched.activeBranches
          .map((b) => `<div data-branch="${escapeHtml(b.name)}">${escapeHtml(b.address ?? "")}</div>`)
          .join("");

        return renderHtmlDocument({
          headHtml: head.html,
          h1: res.pageTitle,
          bodyHtml: `<nav>${renderShellMenuNav(res.shell.menus)}${renderBreadcrumbsNav(res.breadcrumbs)}</nav>${sectionLinks}${offeringLinks}${postLinks}${branchMarkup}`,
          status: res.http.status,
          headers: res.http.headers,
        });
      },
      {
        APP_ENV: "test",
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
        PLATFORM_DB: env.PLATFORM_DB,
        TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      },
      {
        nowMs,
        bypassHostCache: true,
        cache: edgeCache,
      },
    );
  };
}

async function seedTenant(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: "active" | "trial";
  readonly subdomain: string;
}): Promise<D1Database> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(organizations)
    .values({ id: spec.orgId, name: spec.name, slug: spec.handle, createdAt: now, updatedAt: now })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: spec.id,
      organizationId: spec.orgId,
      handle: spec.handle,
      name: spec.name,
      status: spec.status,
      paidThrough: spec.status === "active" ? new Date(BASE_TIME + 30 * DAY_MS) : null,
      trialEndsAt: spec.status === "trial" ? new Date(BASE_TIME + 7 * DAY_MS) : null,
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenantHosts)
    .values({
      tenantId: spec.id,
      host: spec.subdomain,
      kind: "subdomain",
      isPrimary: true,
      status: "active",
      sslStatus: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const stub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    spec.id,
  );
  const allMigrations = Array.from(
    new Map(
      [
        ...TENANT_MIGRATIONS,
        TAXONOMY_ARCHIVE_SETTINGS_MIGRATION,
        BUSINESS_PROFILE_STRUCTURED_MIGRATION,
        TENANT_0013_SEO_EDITOR_SETTINGS_MIGRATION,
        BRANCHES_MIGRATION,
      ].map((m) => [m.version, m]),
    ).values(),
  ).sort((a, b) => a.version - b.version);

  await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, allMigrations);
  return createTenantDb(stub);
}

async function seedReadyMedia(
  tenantDb: D1Database,
  tenantId: string,
  mediaId: number,
  filename: string,
  altText: string,
): Promise<void> {
  const key = `t/${tenantId}/media/${filename}`;
  const variants = JSON.stringify({
    master: { key, width: 1200, height: 800, bytes: 32_000, mimeType: "image/webp" },
    w1280: { key, width: 1200, height: 800, bytes: 32_000, mimeType: "image/webp" },
    og: { key, width: 1200, height: 630, bytes: 28_000, mimeType: "image/jpeg" },
  });
  await tenantDb
    .prepare(
      `INSERT OR REPLACE INTO media_items
         (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, variants_json, status, version, created_at, updated_at)
       VALUES (?, 'image', ?, 'image/webp', 32000, ?, 1200, 800, ?, ?, 'ready', 1, ?, ?)`,
    )
    .bind(mediaId, key, `sha_${tenantId}_${mediaId}`, altText, variants, BASE_TIME, BASE_TIME)
    .run();
}

/**
 * Resets mutable PLATFORM_DB host/status state for Tenant A & Tenant B so every `it(...)`
 * starts from a deterministic baseline and can run standalone (`it.only`) or in any order.
 */
async function resetTenantPlatformBaseline(): Promise<void> {
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_TIME + 5000);

  await pDb
    .update(tenants)
    .set({ status: "active", updatedAt: now })
    .where(eq(tenants.id, TENANT_A.id));

  await pDb
    .update(tenants)
    .set({ status: "trial", updatedAt: now })
    .where(eq(tenants.id, TENANT_B.id));

  await pDb
    .delete(tenantHosts)
    .where(
      and(eq(tenantHosts.tenantId, TENANT_A.id), eq(tenantHosts.host, TENANT_A.customDomain)),
    );

  await pDb
    .update(tenantHosts)
    .set({ isPrimary: true, status: "active", sslStatus: "active", updatedAt: now })
    .where(and(eq(tenantHosts.tenantId, TENANT_A.id), eq(tenantHosts.host, TENANT_A.subdomain)));

  clearHostResolutionCache();
}

async function promoteTenantAToCustomDomain(atMs: number): Promise<void> {
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(atMs);

  await pDb
    .update(tenantHosts)
    .set({ isPrimary: false, updatedAt: now })
    .where(and(eq(tenantHosts.tenantId, TENANT_A.id), eq(tenantHosts.host, TENANT_A.subdomain)));

  await pDb
    .insert(tenantHosts)
    .values({
      tenantId: TENANT_A.id,
      host: TENANT_A.customDomain,
      kind: "custom",
      isPrimary: true,
      status: "active",
      sslStatus: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .update(tenantHosts)
    .set({ isPrimary: true, status: "active", sslStatus: "active", updatedAt: now })
    .where(and(eq(tenantHosts.tenantId, TENANT_A.id), eq(tenantHosts.host, TENANT_A.customDomain)));

  await bumpTenantCacheVersion(env.PLATFORM_DB, TENANT_A.id, atMs);
  clearHostResolutionCache();
}

describe("TASK-054 workerd integration — Two-Tenant Live HTTP Crawl Regression (PLAN.md §15)", () => {
  let alphaDb: D1Database;
  let betaDb: D1Database;
  let alphaPostId: number;
  let alphaPostVersion: number;
  let alphaSeoVersion: number;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    alphaDb = await seedTenant({
      id: TENANT_A.id,
      orgId: TENANT_A.orgId,
      handle: TENANT_A.handle,
      name: TENANT_A.name,
      status: "active",
      subdomain: TENANT_A.subdomain,
    });
    betaDb = await seedTenant({
      id: TENANT_B.id,
      orgId: TENANT_B.orgId,
      handle: TENANT_B.handle,
      name: TENANT_B.name,
      status: "trial",
      subdomain: TENANT_B.subdomain,
    });

    await seedReadyMedia(alphaDb, TENANT_A.id, 1, "logo-alpha.webp", "Logo PT Alpha Arsitektur");
    await seedReadyMedia(alphaDb, TENANT_A.id, 2, "cover-post.webp", "Cover Panduan Audit");
    await seedReadyMedia(alphaDb, TENANT_A.id, 3, "service-audit.webp", "Layanan Audit Bangunan");

    const alphaProfDraft = await saveStructuredBusinessProfileDraft(alphaDb, {
      siteSettings: {
        siteTitle: TENANT_A.name,
        tagline: "Konsultan Arsitektur & Renovasi B2B",
        blogEnabled: true,
        catalogEnabled: true,
        logoMediaId: 1,
      },
      businessProfile: {
        businessName: TENANT_A.name,
        legalName: "PT Alpha Arsitektur Mandiri Indonesia",
        businessCategory: "contractor",
        description: "Layanan desain, audit struktur, dan renovasi ruang kerja komersial.",
        address: "Jl. Senopati Raya No. 22",
        city: "Jakarta Selatan",
        province: "DKI Jakarta",
        postalCode: "12190",
        phone: "021-52901122",
        whatsappE164: "6281234567890",
        email: "halo@t054-alpha.id",
        privacyContact: "privasi@t054-alpha.id",
        weekdayHours: "Senin-Jumat 08:00-17:00 WIB",
        serviceAreas: ["Jakarta Selatan", "Tangerang Selatan"],
      },
      nowMs: BASE_TIME,
    });
    await publishStructuredBusinessProfile(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      expectedVersion: alphaProfDraft.version,
      nowMs: BASE_TIME + 500,
    });
    await saveStructuredBusinessProfileDraft(alphaDb, {
      businessProfile: { legalName: TENANT_A.draftSecret },
      nowMs: BASE_TIME + 600,
    });

    await createBranch(
      alphaDb,
      {
        name: "Cabang BSD City",
        address: "Ruko Golden Boulevard Blok B2",
        city: "Tangerang Selatan",
        province: "Banten",
        phone: "021-5318800",
        whatsappNumber: "081188887777",
        weekdayHours: "Senin-Sabtu 09:00-17:00 WIB",
        isPrimary: true,
        active: true,
      },
      { nowMs: BASE_TIME + 700 },
    );

    const seoDraft = await saveTenantSeoEditorSettingsDraft(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      actorUserId: "u_alpha_owner",
      actorRole: "owner",
      expectedVersion: 1,
      patch: { verification: { google: "gscT054AlphaToken2026" } },
      nowMs: BASE_TIME + 800,
    });
    const seoPub = await publishTenantSeoEditorSettings(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      actorUserId: "u_alpha_owner",
      actorRole: "owner",
      expectedVersion: seoDraft.version,
      nowMs: BASE_TIME + 850,
    });
    const seoChecked = await recordExternalVerificationCheck(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      actorUserId: "u_alpha_owner",
      actorRole: "owner",
      expectedVersion: seoPub.version,
      payload: {
        provider: "google",
        verifiedHost: TENANT_A.subdomain,
        note: "Verified manually on staging subdomain",
      },
      nowMs: BASE_TIME + 870,
    });
    const seoDraft2 = await saveTenantSeoEditorSettingsDraft(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      actorUserId: "u_alpha_owner",
      actorRole: "owner",
      expectedVersion: seoChecked.version,
      patch: { verification: { bing: TENANT_A.draftToken } },
      nowMs: BASE_TIME + 900,
    });
    alphaSeoVersion = seoDraft2.version;

    const home = await createPage(alphaDb, {
      title: "Beranda PT Alpha",
      slug: "beranda",
      isHomepage: true,
      sections: [
        {
          id: "hero-1",
          kind: "hero",
          heading: "Arsitektur & Renovasi B2B Terukur",
          subheading: "Desain transparan dengan jadwal pasti.",
          bodyHtml: null,
          ctaLabel: "Lihat Layanan Audit",
          ctaHref: "/layanan/audit-gedung",
        },
        {
          id: "links-1",
          kind: "about",
          heading: "Tentang & Panduan",
          subheading: null,
          bodyHtml:
            '<p>Pelajari <a href="/tentang-kami">profil perusahaan</a>, baca <a href="/blog">artikel blog</a>, atau cek <a href="/produk/partisi-kantor">katalog produk</a>.</p>',
        },
      ],
      nowMs: BASE_TIME + 1000,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      pageId: home.id,
      expectedVersion: home.version,
      nowMs: BASE_TIME + 1100,
    });

    const about = await createPage(alphaDb, {
      title: "Tentang Kami",
      slug: "tentang-lama",
      sections: [
        {
          id: "about-body",
          kind: "about",
          heading: "Profil PT Alpha",
          subheading: null,
          bodyHtml: '<p>Tim profesional sejak 2018. Lihat <a href="/layanan">daftar layanan</a>.</p>',
        },
      ],
      nowMs: BASE_TIME + 1200,
    });
    const aboutPub = await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      pageId: about.id,
      expectedVersion: about.version,
      nowMs: BASE_TIME + 1250,
    });
    const aboutRenamed = await updatePage(alphaDb, {
      pageId: about.id,
      expectedVersion: aboutPub.page.version,
      slug: "tentang-kami",
      confirmSlugChange: true,
      nowMs: BASE_TIME + 1300,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      pageId: about.id,
      expectedVersion: aboutRenamed.version,
      nowMs: BASE_TIME + 1350,
    });

    const noindexPage = await createPage(alphaDb, {
      title: "Halaman Promo Internal",
      slug: "promo-internal",
      sections: [
        {
          id: "promo-1",
          kind: "about",
          heading: "Promo Khusus Klien Lama",
          subheading: null,
          bodyHtml: '<p>Kembali ke <a href="/">beranda</a>.</p>',
        },
      ],
      seo: { noindex: true },
      nowMs: BASE_TIME + 1400,
    });
    await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      pageId: noindexPage.id,
      expectedVersion: noindexPage.version,
      nowMs: BASE_TIME + 1450,
    });

    await createPage(alphaDb, {
      title: `Draf ${TENANT_A.draftSecret}`,
      slug: "halaman-draf-rahasia",
      sections: [],
      nowMs: BASE_TIME + 1500,
    });

    const trashed = await createPage(alphaDb, {
      title: "Halaman Dihapus",
      slug: "halaman-dihapus",
      sections: [],
      nowMs: BASE_TIME + 1550,
    });
    const trashedPub = await publishPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      pageId: trashed.id,
      expectedVersion: trashed.version,
      nowMs: BASE_TIME + 1580,
    });
    await trashPage(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      pageId: trashed.id,
      expectedVersion: trashedPub.page.version,
      nowMs: BASE_TIME + 1600,
    });

    const author = await createPublicAuthor(
      alphaDb,
      {
        name: "Budi Santoso",
        slug: "budi-santoso",
        bio: "Arsitek kepala spesialis audit struktur dan renovasi gedung perkantoran.",
        nowMs: BASE_TIME + 2000,
      },
      { tenantId: TENANT_A.id },
    );
    const catOptedIn = await createTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Panduan Audit",
      slug: "panduan-audit",
      description: "Panduan teknis audit kelayakan struktur dan renovasi kantor B2B.",
      indexOptIn: true,
      nowMs: BASE_TIME + 2100,
    });
    await createTaxonomy(alphaDb, {
      kind: "post_category",
      name: "Kategori Kosong Opted In",
      slug: "kategori-kosong",
      description: "Kategori ini sengaja kosong untuk menguji aturan noindex arsip kosong.",
      indexOptIn: true,
      nowMs: BASE_TIME + 2120,
    });
    const tagDefault = await createTaxonomy(alphaDb, {
      kind: "post_tag",
      name: "Tips Kantor",
      slug: "tips-kantor",
      nowMs: BASE_TIME + 2150,
    });

    const post1 = await createPost(alphaDb, {
      title: 'Audit Gedung </script><script>alert("xss")</script> & Checklist',
      slug: "audit-gedung-checklist",
      excerpt: 'Checklist aman "onclick=evil()" untuk renovasi gedung kantor.',
      bodyHtml:
        '<p>Langkah awal renovasi adalah audit. Lihat <a href="/layanan/audit-gedung">layanan audit gedung</a>.</p><h2>Struktur Utama</h2><p>Periksa kolom dan balok.</p>',
      authorId: author.id,
      authorName: author.name,
      primaryCategoryId: catOptedIn.id,
      categoryIds: [catOptedIn.id],
      tagIds: [tagDefault.id],
      coverMediaId: 2,
      showToc: true,
      nowMs: BASE_TIME + 2200,
    });
    const post1Pub = await publishPost(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      postId: post1.id,
      expectedVersion: post1.version,
      nowMs: BASE_TIME + 2250,
    });
    alphaPostId = post1.id;
    alphaPostVersion = post1Pub.post.version;

    // 10 total published posts in `panduan-audit` (pageSize=9 -> `/blog?page=2` & `/blog/category/panduan-audit?page=2`)
    for (let i = 2; i <= 10; i += 1) {
      const p = await createPost(alphaDb, {
        title: `Panduan Renovasi Seri ${i}`,
        slug: `panduan-renovasi-seri-${i}`,
        excerpt: `Ringkasan praktis seri ${i} untuk proyek kantor.`,
        bodyHtml: `<p>Konten panduan seri ${i}. Kembali ke <a href="/blog">blog</a>.</p>`,
        authorId: author.id,
        authorName: author.name,
        primaryCategoryId: catOptedIn.id,
        categoryIds: [catOptedIn.id],
        nowMs: BASE_TIME + 2300 + i * 10,
      });
      await publishPost(env.PLATFORM_DB, alphaDb, {
        tenantId: TENANT_A.id,
        postId: p.id,
        expectedVersion: p.version,
        nowMs: BASE_TIME + 2500 + i * 10,
      });
    }

    await createPost(alphaDb, {
      title: `Post Draf ${TENANT_A.draftSecret}`,
      slug: "post-draf-rahasia",
      bodyHtml: "<p>Rahasia</p>",
      nowMs: BASE_TIME + 2700,
    });

    const svcCat = await createCatalogCategory(
      alphaDb,
      {
        offeringType: "service",
        name: "Audit Bangunan",
        slug: "audit-bangunan",
        description: "Kategori layanan audit bangunan komersial dan perkantoran.",
      },
      { nowMs: BASE_TIME + 3000 },
    );
    const svc = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "service",
        title: "Audit Kelayakan Gedung Kantor",
        slug: "audit-gedung",
        summary: "Pemeriksaan struktur, MEP, dan estimasi RAB terukur.",
        priceMode: "from",
        price: 15_000_000,
        ctaMode: "whatsapp",
        coverMediaId: 3,
        categoryIds: [svcCat.id],
      },
      { nowMs: BASE_TIME + 3100 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      offeringId: svc.id,
      expectedVersion: svc.version,
      nowMs: BASE_TIME + 3150,
    });

    const prod = await createCatalogOffering(
      alphaDb,
      {
        offeringType: "product",
        title: "Partisi Akustik Kantor",
        slug: "partisi-kantor",
        summary: "Partisi peredam suara ruang rapat dengan harga transparan.",
        priceMode: "fixed",
        price: 4_500_000,
        ctaMode: "whatsapp",
        seo: { schemaType: "Product" },
      },
      { nowMs: BASE_TIME + 3200 },
    );
    await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      offeringId: prod.id,
      expectedVersion: prod.version,
      nowMs: BASE_TIME + 3250,
    });

    const betaProf = await saveStructuredBusinessProfileDraft(betaDb, {
      siteSettings: {
        siteTitle: TENANT_B.name,
        tagline: TENANT_B.secretSentinel,
        blogEnabled: true,
        catalogEnabled: true,
      },
      businessProfile: {
        businessName: TENANT_B.name,
        businessCategory: "local_business",
        description: `Deskripsi privat ${TENANT_B.secretSentinel}`,
        whatsappE164: "6281399990000",
      },
      nowMs: BASE_TIME + 4000,
    });
    await publishStructuredBusinessProfile(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_B.id,
      expectedVersion: betaProf.version,
      nowMs: BASE_TIME + 4100,
    });

    const betaHome = await createPage(betaDb, {
      title: `Beranda ${TENANT_B.name}`,
      slug: "beranda-beta",
      isHomepage: true,
      sections: [
        {
          id: "beta-hero",
          kind: "hero",
          heading: TENANT_B.secretSentinel,
          subheading: "Halaman uji coba trial.",
          bodyHtml: null,
        },
      ],
      nowMs: BASE_TIME + 4200,
    });
    await publishPage(env.PLATFORM_DB, betaDb, {
      tenantId: TENANT_B.id,
      pageId: betaHome.id,
      expectedVersion: betaHome.version,
      nowMs: BASE_TIME + 4250,
    });
  });

  beforeEach(async () => {
    await resetTenantPlatformBaseline();
  });

  it("crawls two isolated tenants over live HTTP, enforces zero cross-tenant leakage, single head/JSON-LD, whole-document XSS escaping, and zero broken internal links", async () => {
    const crawlFetch = createLiveCrawlFetcher();
    const originA = `https://${TENANT_A.subdomain}`;
    const originB = `https://${TENANT_B.subdomain}`;

    // 1. Tenant A `/robots.txt`, `/sitemap.xml`, sub-sitemaps, and `/blog/feed.xml`
    const robotsResA = await crawlFetch(`${originA}/robots.txt`);
    expect(robotsResA.status).toBe(200);
    const robotsBodyA = await robotsResA.text();
    const parsedRobotsA = parseRobotsTxt(robotsBodyA);
    expect(parsedRobotsA.disallowAllWildcard).toBe(false);
    expect(parsedRobotsA.sitemaps).toEqual([`${originA}/sitemap.xml`]);
    expect(isPathAllowedByRobotsTxt(robotsBodyA, "Googlebot", "/promo-internal")).toBe(true);
    expect(
      findCrossTenantLeaks(robotsBodyA, [TENANT_B.handle, TENANT_B.subdomain, TENANT_B.secretSentinel]),
    ).toEqual([]);

    const indexResA = await crawlFetch(`${originA}/sitemap.xml`);
    expect(indexResA.status).toBe(200);
    const indexXmlA = await indexResA.text();
    expect(indexXmlA).not.toMatch(/<script\b/i);
    const auditedIndexA = auditSitemapIndexXml(indexXmlA, originA);
    expect(auditedIndexA.duplicateLocs).toEqual([]);
    expect(auditedIndexA.foreignOriginLocs).toEqual([]);
    expect(auditedIndexA.invalidLastmods).toEqual([]);
    expect(auditedIndexA.entries.map((e) => e.loc)).toEqual([
      `${originA}/sitemaps/pages.xml`,
      `${originA}/sitemaps/posts.xml`,
      `${originA}/sitemaps/offerings.xml`,
    ]);

    const discoveredSitemapUrls = new Set<string>();
    for (const sub of auditedIndexA.entries) {
      const subRes = await crawlFetch(sub.loc);
      expect(subRes.status).toBe(200);
      const subXml = await subRes.text();
      expect(subXml).not.toMatch(/<script\b/i);
      const subAudit = auditUrlsetXml(subXml, originA);
      expect(subAudit.duplicateLocs).toEqual([]);
      expect(subAudit.foreignOriginLocs).toEqual([]);
      expect(subAudit.invalidLastmods).toEqual([]);
      expect(subAudit.paginatedOrTrackedLocs).toEqual([]);
      expect(subAudit.exceedsUrlLimit).toBe(false);
      expect(subAudit.exceedsByteLimit).toBe(false);
      // Zero draft/trashed/noindex/tag/empty/former-slug/cross-tenant URLs in any sub-sitemap
      expect(
        findCrossTenantLeaks(subXml, [
          TENANT_B.handle,
          TENANT_B.subdomain,
          TENANT_B.secretSentinel,
          TENANT_A.draftSecret,
          "halaman-draf-rahasia",
          "halaman-dihapus",
          "post-draf-rahasia",
          "promo-internal",
          "tentang-lama",
          "tips-kantor",
          "kategori-kosong",
        ]),
      ).toEqual([]);
      for (const entry of subAudit.entries) {
        discoveredSitemapUrls.add(entry.loc);
      }
    }

    expect(discoveredSitemapUrls.has(`${originA}/`)).toBe(true);
    expect(discoveredSitemapUrls.has(`${originA}/tentang-kami`)).toBe(true);
    expect(discoveredSitemapUrls.has(`${originA}/blog`)).toBe(true);
    expect(discoveredSitemapUrls.has(`${originA}/blog/audit-gedung-checklist`)).toBe(true);
    expect(discoveredSitemapUrls.has(`${originA}/layanan`)).toBe(true);
    expect(discoveredSitemapUrls.has(`${originA}/layanan/audit-gedung`)).toBe(true);
    expect(discoveredSitemapUrls.has(`${originA}/produk/partisi-kantor`)).toBe(true);

    const rssRes = await crawlFetch(`${originA}/blog/feed.xml`);
    expect(rssRes.status).toBe(200);
    const rssXml = await rssRes.text();
    expect(parseStrictCrawlXml(rssXml).name).toBe("rss");
    expect(rssXml).not.toMatch(/<script\b/i);
    expect(
      findCrossTenantLeaks(rssXml, [TENANT_A.draftSecret, "post-draf-rahasia", TENANT_B.subdomain]),
    ).toEqual([]);

    // 2. Crawl every discovered Tenant A sitemap URL & enforce head + whole-document XSS + schema + zero-leak invariants
    const crawledPages: Array<{
      readonly url: string;
      readonly internalHrefs: readonly string[];
      readonly foreignOriginLinks: readonly string[];
    }> = [];
    for (const pageUrl of discoveredSitemapUrls) {
      const res = await crawlFetch(pageUrl);
      expect(res.status, `Sitemap URL ${pageUrl} must return 200`).toBe(200);
      const html = await res.text();
      expect(
        findCrossTenantLeaks(html, [
          TENANT_B.handle,
          TENANT_B.subdomain,
          TENANT_B.name,
          TENANT_B.secretSentinel,
          TENANT_A.draftSecret,
          TENANT_A.draftToken,
        ]),
        `Leak found on ${pageUrl}`,
      ).toEqual([]);

      const audit = auditHttpCrawlPage({
        url: pageUrl,
        status: res.status,
        html,
        xRobotsTagHeader: res.headers.get("x-robots-tag"),
        expectedOrigin: originA,
      });
      expect(audit.titleCount, `${pageUrl}: single <title>`).toBe(1);
      expect(audit.descriptionCount, `${pageUrl}: at most one <meta name="description">`).toBeLessThanOrEqual(1);
      expect(audit.robotsMetaCount, `${pageUrl}: single <meta name="robots">`).toBe(1);
      expect(audit.robotsParity.consistent, `${pageUrl}: ${audit.robotsParity.contradictionReason ?? ""}`).toBe(true);
      expect(audit.robotsParity.metaIsNoindex, `${pageUrl}: sitemap URL must be indexable`).toBe(false);
      expect(audit.canonicalCount, `${pageUrl}: single canonical`).toBe(1);
      expect(audit.canonicalHref, `${pageUrl}: self canonical`).toBe(pageUrl);
      expect(audit.canonicalHasTrackingParams).toBe(false);
      expect(audit.canonicalMatchesExpectedOrigin).toBe(true);
      expect(audit.verificationTokens.google).toBe("gscT054AlphaToken2026");
      expect(audit.verificationTokens.bing).toBeNull();
      expect(audit.jsonLdCount, `${pageUrl}: single JSON-LD @graph`).toBe(1);
      expect(audit.jsonLdScripts[0]?.parseError).toBeNull();
      expect(audit.jsonLdScripts[0]?.hasRawScriptBreakout).toBe(false);
      expect(audit.hasUnescapedHtmlInjectionInHead, `${pageUrl}: head XSS check`).toBe(false);
      expect(audit.hasUnescapedHtmlInjectionInDocument, `${pageUrl}: whole-document XSS check`).toBe(false);
      expect(audit.hasForbiddenSchemaProps).toBe(false);
      expect(audit.jsonLdForeignOriginUrls).toEqual([]);
      expect(audit.h1Count).toBe(1);

      crawledPages.push({
        url: pageUrl,
        internalHrefs: audit.internalHrefs,
        foreignOriginLinks: audit.foreignOriginLinks,
      });
    }

    // 3. Enforce 0 broken internal links & 0 cross-tenant links across all crawled Tenant A routes
    const linkAudit = await auditInternalLinksOverHttp({
      origin: originA,
      pages: crawledPages,
      forbiddenOrigins: [originB],
      fetchRoute: (u) => crawlFetch(u),
    });
    expect(linkAudit.checkedCount).toBeGreaterThan(0);
    expect(linkAudit.broken).toEqual([]);

    // 4. Tracking query variant strips UTM/fbclid from canonical on live HTTP response
    const trackedRes = await crawlFetch(`${originA}/layanan/audit-gedung?utm_source=ig&fbclid=xyz123`);
    expect(trackedRes.status).toBe(200);
    const trackedAudit = auditHttpCrawlPage({
      url: `${originA}/layanan/audit-gedung?utm_source=ig&fbclid=xyz123`,
      status: trackedRes.status,
      html: await trackedRes.text(),
      xRobotsTagHeader: trackedRes.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(trackedAudit.canonicalHref).toBe(`${originA}/layanan/audit-gedung`);
    expect(trackedAudit.canonicalHasTrackingParams).toBe(false);
    expect(trackedAudit.hasUnescapedHtmlInjectionInDocument).toBe(false);

    // 5. Crawl Tenant B (Trial / noindex): zero cross-tenant leakage & consistent noindex policy
    const robotsResB = await crawlFetch(`${originB}/robots.txt`);
    expect(robotsResB.status).toBe(200);
    const parsedRobotsB = parseRobotsTxt(await robotsResB.text());
    expect(parsedRobotsB.disallowAllWildcard).toBe(true);
    expect(parsedRobotsB.sitemaps).toEqual([]);

    const sitemapResB = await crawlFetch(`${originB}/sitemap.xml`);
    expect(sitemapResB.status).toBe(404);
    expect(sitemapResB.headers.get("cache-control")).toBe("no-store");
    expect(sitemapResB.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const homeResB = await crawlFetch(`${originB}/`);
    expect(homeResB.status).toBe(200);
    const homeHtmlB = await homeResB.text();
    expect(
      findCrossTenantLeaks(homeHtmlB, [TENANT_A.handle, TENANT_A.subdomain, TENANT_A.name, "gscT054AlphaToken2026"]),
    ).toEqual([]);
    const homeAuditB = auditHttpCrawlPage({
      url: `${originB}/`,
      status: homeResB.status,
      html: homeHtmlB,
      xRobotsTagHeader: homeResB.headers.get("x-robots-tag"),
      expectedOrigin: originB,
    });
    expect(homeAuditB.titleCount).toBe(1);
    expect(homeAuditB.descriptionCount).toBeLessThanOrEqual(1);
    expect(homeAuditB.robotsMetaCount).toBe(1);
    expect(homeAuditB.robotsParity.consistent).toBe(true);
    expect(homeAuditB.robotsParity.metaIsNoindex).toBe(true);
    expect(homeAuditB.robotsParity.headerIsNoindex).toBe(true);
    expect(homeAuditB.hasUnescapedHtmlInjectionInDocument).toBe(false);
  });

  it("enforces sitemap chunking pagination, revision/lastmod updates only on publish, taxonomy archives + pagination, per-page noindex, and 404 safety", async () => {
    const originA = `https://${TENANT_A.subdomain}`;

    // 1. Sitemap chunking with tight ceiling (`maxUrlsPerSitemap: 4`)
    const chunkedFetch = createLiveCrawlFetcher({ maxUrlsPerSitemap: 4 });
    const chunkedIdxRes = await chunkedFetch(`${originA}/sitemap.xml`);
    expect(chunkedIdxRes.status).toBe(200);
    const chunkedIdx = auditSitemapIndexXml(await chunkedIdxRes.text(), originA);
    const postChunks = chunkedIdx.entries.filter((e) => e.loc.includes("/sitemaps/posts"));
    expect(postChunks.length).toBeGreaterThanOrEqual(3);
    expect(postChunks[0]?.loc).toBe(`${originA}/sitemaps/posts.xml`);
    expect(postChunks[1]?.loc).toBe(`${originA}/sitemaps/posts-2.xml`);

    const chunk2Res = await chunkedFetch(`${originA}/sitemaps/posts-2.xml`);
    expect(chunk2Res.status).toBe(200);
    const chunk2Audit = auditUrlsetXml(await chunk2Res.text(), originA, { maxUrls: 4 });
    expect(chunk2Audit.entries.length).toBeLessThanOrEqual(4);
    expect(chunk2Audit.exceedsUrlLimit).toBe(false);

    const outOfRangeChunk = await chunkedFetch(`${originA}/sitemaps/posts-99.xml`);
    expect(outOfRangeChunk.status).toBe(404);
    expect(outOfRangeChunk.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    // 2. Revision / `<lastmod>` changes ONLY on publish (draft edit MUST NOT change `<lastmod>` or `cache_version`!)
    const crawlFetch = createLiveCrawlFetcher();
    const postsBeforeRes = await crawlFetch(`${originA}/sitemaps/posts.xml`);
    const versionBefore = Number(postsBeforeRes.headers.get(CACHE_VERSION_HEADER_NAME));
    const etagBefore = postsBeforeRes.headers.get("etag");
    const postsBeforeAudit = auditUrlsetXml(await postsBeforeRes.text(), originA);
    const targetBefore = postsBeforeAudit.entries.find(
      (e) => e.loc === `${originA}/blog/audit-gedung-checklist`,
    );
    expect(targetBefore?.lastmod).toBeTruthy();

    const postDraft = await updatePost(alphaDb, {
      postId: alphaPostId,
      expectedVersion: alphaPostVersion,
      excerpt: `DRAF BARU ${TENANT_A.draftSecret}`,
      nowMs: BASE_TIME + 50_000,
    });
    const postsAfterDraftRes = await createLiveCrawlFetcher()(`${originA}/sitemaps/posts.xml`);
    expect(Number(postsAfterDraftRes.headers.get(CACHE_VERSION_HEADER_NAME))).toBe(versionBefore);
    expect(postsAfterDraftRes.headers.get("etag")).toBe(etagBefore);
    const postsAfterDraftXml = await postsAfterDraftRes.text();
    expect(postsAfterDraftXml).not.toContain(TENANT_A.draftSecret);
    const postsAfterDraftAudit = auditUrlsetXml(postsAfterDraftXml, originA);
    const targetAfterDraft = postsAfterDraftAudit.entries.find(
      (e) => e.loc === `${originA}/blog/audit-gedung-checklist`,
    );
    expect(targetAfterDraft?.lastmod).toBe(targetBefore?.lastmod);

    // Replace draft sentinel with a clean substantive edit before publishing so live published
    // state NEVER contains `TENANT_A.draftSecret` (keeps all tests strictly order-independent).
    const postReadyToPublish = await updatePost(alphaDb, {
      postId: alphaPostId,
      expectedVersion: postDraft.version,
      excerpt: "Checklist terbaru terverifikasi untuk renovasi gedung kantor B2B.",
      nowMs: BASE_TIME + 90_000,
    });

    const postPublished2 = await publishPost(env.PLATFORM_DB, alphaDb, {
      tenantId: TENANT_A.id,
      postId: alphaPostId,
      expectedVersion: postReadyToPublish.version,
      nowMs: BASE_TIME + 120_000,
    });
    alphaPostVersion = postPublished2.post.version;

    const postsAfterPubRes = await crawlFetch(`${originA}/sitemaps/posts.xml`);
    expect(Number(postsAfterPubRes.headers.get(CACHE_VERSION_HEADER_NAME))).toBeGreaterThan(
      versionBefore,
    );
    expect(postsAfterPubRes.headers.get("etag")).not.toBe(etagBefore);
    const postsAfterPubAudit = auditUrlsetXml(await postsAfterPubRes.text(), originA);
    const targetAfterPub = postsAfterPubAudit.entries.find(
      (e) => e.loc === `${originA}/blog/audit-gedung-checklist`,
    );
    expect(targetAfterPub?.lastmod).toBe(new Date(BASE_TIME + 120_000).toISOString());

    // 3. Taxonomy archives + taxonomy pagination matrix (`?page=1` -> 301, `?page=2` -> 200 canonical, `?page=99` -> 404)
    const catRes = await crawlFetch(`${originA}/blog/category/panduan-audit`);
    expect(catRes.status).toBe(200);
    const catAudit = auditHttpCrawlPage({
      url: `${originA}/blog/category/panduan-audit`,
      status: catRes.status,
      html: await catRes.text(),
      xRobotsTagHeader: catRes.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(catAudit.descriptionCount).toBeLessThanOrEqual(1);
    expect(catAudit.robotsParity.consistent).toBe(true);
    expect(catAudit.robotsParity.metaIsNoindex).toBe(false);
    expect(catAudit.canonicalHref).toBe(`${originA}/blog/category/panduan-audit`);
    expect(catAudit.hasUnescapedHtmlInjectionInDocument).toBe(false);

    const taxPage1 = await crawlFetch(`${originA}/blog/category/panduan-audit?page=1`);
    expect(taxPage1.status).toBe(301);
    expect(taxPage1.headers.get("location")).toBe(`${originA}/blog/category/panduan-audit`);

    const taxPage2 = await crawlFetch(`${originA}/blog/category/panduan-audit?page=2`);
    expect(taxPage2.status).toBe(200);
    const taxPage2Audit = auditHttpCrawlPage({
      url: `${originA}/blog/category/panduan-audit?page=2`,
      status: taxPage2.status,
      html: await taxPage2.text(),
      xRobotsTagHeader: taxPage2.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(taxPage2Audit.canonicalHref).toBe(`${originA}/blog/category/panduan-audit?page=2`);
    expect(taxPage2Audit.robotsParity.consistent).toBe(true);

    const taxPage99 = await crawlFetch(`${originA}/blog/category/panduan-audit?page=99`);
    expect(taxPage99.status).toBe(404);
    expect(taxPage99.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    // Non-opted-in blog tag -> 200 noindex, follow (meta + X-Robots-Tag parity)
    const tagRes = await crawlFetch(`${originA}/blog/tag/tips-kantor`);
    expect(tagRes.status).toBe(200);
    const tagAudit = auditHttpCrawlPage({
      url: `${originA}/blog/tag/tips-kantor`,
      status: tagRes.status,
      html: await tagRes.text(),
      xRobotsTagHeader: tagRes.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(tagAudit.robotsParity.consistent).toBe(true);
    expect(tagAudit.robotsParity.metaIsNoindex).toBe(true);
    expect(tagAudit.robotsParity.headerIsNoindex).toBe(true);

    // Opted-in EMPTY blog category -> 200 noindex, follow
    const emptyCatRes = await crawlFetch(`${originA}/blog/category/kategori-kosong`);
    expect(emptyCatRes.status).toBe(200);
    const emptyCatAudit = auditHttpCrawlPage({
      url: `${originA}/blog/category/kategori-kosong`,
      status: emptyCatRes.status,
      html: await emptyCatRes.text(),
      xRobotsTagHeader: emptyCatRes.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(emptyCatAudit.robotsParity.consistent).toBe(true);
    expect(emptyCatAudit.robotsParity.metaIsNoindex).toBe(true);

    // Offering category archive
    const svcCatRes = await crawlFetch(`${originA}/layanan/category/audit-bangunan`);
    expect(svcCatRes.status).toBe(200);
    const svcCatAudit = auditHttpCrawlPage({
      url: `${originA}/layanan/category/audit-bangunan`,
      status: svcCatRes.status,
      html: await svcCatRes.text(),
      xRobotsTagHeader: svcCatRes.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(svcCatAudit.robotsParity.consistent).toBe(true);
    expect(svcCatAudit.canonicalCount).toBe(1);

    // Blog index pagination: `?page=1` -> 301; `?page=2` -> 200 canonical `?page=2`; `?page=99` -> 404
    const p1Res = await crawlFetch(`${originA}/blog?page=1`);
    expect(p1Res.status).toBe(301);
    expect(p1Res.headers.get("location")).toBe(`${originA}/blog`);

    const p2Res = await crawlFetch(`${originA}/blog?page=2`);
    expect(p2Res.status).toBe(200);
    const p2Audit = auditHttpCrawlPage({
      url: `${originA}/blog?page=2`,
      status: p2Res.status,
      html: await p2Res.text(),
      xRobotsTagHeader: p2Res.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(p2Audit.canonicalHref).toBe(`${originA}/blog?page=2`);

    const p99Res = await crawlFetch(`${originA}/blog?page=99`);
    expect(p99Res.status).toBe(404);
    expect(p99Res.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    // 4. Per-page noindex consistency
    const promoRes = await crawlFetch(`${originA}/promo-internal`);
    expect(promoRes.status).toBe(200);
    const promoAudit = auditHttpCrawlPage({
      url: `${originA}/promo-internal`,
      status: promoRes.status,
      html: await promoRes.text(),
      xRobotsTagHeader: promoRes.headers.get("x-robots-tag"),
      expectedOrigin: originA,
    });
    expect(promoAudit.robotsParity.consistent).toBe(true);
    expect(promoAudit.robotsParity.metaIsNoindex).toBe(true);
    expect(promoAudit.canonicalHref).toBe(`${originA}/promo-internal`);

    // 5. Former slug & homepage slug 308 redirects
    const formerRes = await crawlFetch(`${originA}/tentang-lama`);
    expect(formerRes.status).toBe(308);
    expect(formerRes.headers.get("location")).toBe(`${originA}/tentang-kami`);

    const homeSlugRes = await crawlFetch(`${originA}/beranda`);
    expect(homeSlugRes.status).toBe(308);
    expect(homeSlugRes.headers.get("location")).toBe(`${originA}/`);

    // 6. 404 + noindex on nonexistent, draft, and trashed slugs + spoofed header isolation
    for (const missingPath of [
      "/rute-tidak-ada-2026",
      "/blog/artikel-tidak-ada",
      "/layanan/jasa-tidak-ada",
      "/halaman-draf-rahasia",
      "/halaman-dihapus",
      "/blog/post-draf-rahasia",
    ]) {
      const r404 = await crawlFetch(`${originA}${missingPath}`);
      expect(r404.status, `${missingPath} must return 404`).toBe(404);
      expect(r404.headers.get("cache-control")).toBe("no-store");
      expect(r404.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const html404 = await r404.text();
      expect(html404).not.toContain(TENANT_A.draftSecret);
      const a404 = auditHttpCrawlPage({
        url: `${originA}${missingPath}`,
        status: r404.status,
        html: html404,
        xRobotsTagHeader: r404.headers.get("x-robots-tag"),
        expectedOrigin: originA,
      });
      expect(a404.robotsParity.consistent).toBe(true);
      expect(a404.robotsParity.metaIsNoindex).toBe(true);
      expect(a404.canonicalCount).toBe(0);
      expect(a404.jsonLdCount).toBe(0);
    }

    const spoofedRes = await crawlFetch(`${originA}/`, {
      headers: {
        "X-Forwarded-Host": TENANT_B.subdomain,
        "X-Tenant-ID": TENANT_B.id,
      },
    });
    expect(spoofedRes.status).toBe(200);
    expect(
      findCrossTenantLeaks(await spoofedRes.text(), [TENANT_B.subdomain, TENANT_B.secretSentinel]),
    ).toEqual([]);

    const unknownRes = await crawlFetch("https://unknown-host.situsku.click/");
    expect(unknownRes.status).toBe(404);
    expect(unknownRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(unknownRes.headers.get("cache-control")).toBe("no-store");
  });

  it("handles live primary-domain switch (subdomain -> custom domain) cleanly across redirects, canonicals, sitemaps, schema, and webmaster verification recheck", async () => {
    await promoteTenantAToCustomDomain(BASE_TIME + 200_000);

    const crawlFetch = createLiveCrawlFetcher({ nowMs: BASE_TIME + 200_500 });
    const oldOrigin = `https://${TENANT_A.subdomain}`;
    const newOrigin = `https://${TENANT_A.customDomain}`;

    for (const testPath of [
      "/",
      "/layanan/audit-gedung?utm_source=gsc",
      "/robots.txt",
      "/sitemap.xml",
      "/sitemaps/pages.xml",
    ]) {
      const redirRes = await crawlFetch(`${oldOrigin}${testPath}`);
      expect([301, 308]).toContain(redirRes.status);
      expect(redirRes.headers.get("location")).toBe(`${newOrigin}${testPath}`);
    }

    const newRobotsRes = await crawlFetch(`${newOrigin}/robots.txt`);
    expect(newRobotsRes.status).toBe(200);
    expect(parseRobotsTxt(await newRobotsRes.text()).sitemaps).toEqual([`${newOrigin}/sitemap.xml`]);

    const newIndexRes = await crawlFetch(`${newOrigin}/sitemap.xml`);
    expect(newIndexRes.status).toBe(200);
    const newIndexXml = await newIndexRes.text();
    expect(newIndexXml).not.toContain(TENANT_A.subdomain);
    expect(auditSitemapIndexXml(newIndexXml, newOrigin).foreignOriginLocs).toEqual([]);

    const newPagesRes = await crawlFetch(`${newOrigin}/sitemaps/pages.xml`);
    expect(newPagesRes.status).toBe(200);
    const newPagesXml = await newPagesRes.text();
    expect(newPagesXml).not.toContain(TENANT_A.subdomain);
    const newPagesAudit = auditUrlsetXml(newPagesXml, newOrigin);
    expect(newPagesAudit.foreignOriginLocs).toEqual([]);
    expect(newPagesAudit.entries.map((e) => e.loc)).toContain(`${newOrigin}/`);
    expect(newPagesAudit.entries.map((e) => e.loc)).toContain(`${newOrigin}/tentang-kami`);

    const newHomeRes = await crawlFetch(`${newOrigin}/`);
    expect(newHomeRes.status).toBe(200);
    const newHomeHtml = await newHomeRes.text();
    expect(newHomeHtml).not.toContain(TENANT_A.subdomain);
    const newHomeAudit = auditHttpCrawlPage({
      url: `${newOrigin}/`,
      status: newHomeRes.status,
      html: newHomeHtml,
      xRobotsTagHeader: newHomeRes.headers.get("x-robots-tag"),
      expectedOrigin: newOrigin,
    });
    expect(newHomeAudit.canonicalHref).toBe(`${newOrigin}/`);
    expect(newHomeAudit.descriptionCount).toBeLessThanOrEqual(1);
    expect(newHomeAudit.jsonLdForeignOriginUrls).toEqual([]);
    expect(newHomeAudit.hasUnescapedHtmlInjectionInDocument).toBe(false);

    const seoSettingsAfterSwitch = await getTenantSeoEditorSettings(
      env.PLATFORM_DB,
      alphaDb,
      TENANT_A.id,
      { nowMs: BASE_TIME + 201_000 },
    );
    expect(seoSettingsAfterSwitch.primaryHost).toBe(TENANT_A.customDomain);
    const googleStatus = seoSettingsAfterSwitch.verificationStatuses.find(
      (s) => s.provider === "google",
    );
    expect(googleStatus?.status).toBe("recheck_required");
    expect(googleStatus?.domainChangedSinceVerification).toBe(true);
    expect(seoSettingsAfterSwitch.version).toBeGreaterThanOrEqual(alphaSeoVersion);
  });

  it("enforces warm-cache suspension safety across HTML pages, /robots.txt, and /sitemap.xml (Step 8a runs before edge cache)", async () => {
    await promoteTenantAToCustomDomain(BASE_TIME + 300_000);
    const edgeCache = createInMemoryEdgeCache();
    const crawlFetch = createLiveCrawlFetcher({ cache: edgeCache, nowMs: BASE_TIME + 300_500 });
    const originA = `https://${TENANT_A.customDomain}`;

    // 1. Warm the edge cache on HTML pages AND `/robots.txt` AND `/sitemap.xml` AND `/sitemaps/pages.xml`
    for (const warmPath of [
      "/",
      "/layanan/audit-gedung",
      "/robots.txt",
      "/sitemap.xml",
      "/sitemaps/pages.xml",
    ]) {
      const missRes = await crawlFetch(`${originA}${warmPath}`);
      expect(missRes.status, `Warm MISS ${warmPath}`).toBe(200);
      expect(missRes.headers.get("x-punyasitus-cache")).toBe("MISS");

      const hitRes = await crawlFetch(`${originA}${warmPath}`);
      expect(hitRes.status, `Warm HIT ${warmPath}`).toBe(200);
      expect(hitRes.headers.get("x-punyasitus-cache")).toBe("HIT");
    }

    // 2. Suspend Tenant A in PLATFORM_DB WITHOUT clearing edgeCache!
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await pDb
      .update(tenants)
      .set({ status: "suspended", updatedAt: new Date(BASE_TIME + 301_000) })
      .where(eq(tenants.id, TENANT_A.id));
    clearHostResolutionCache();

    // 3. Every warmed route (HTML + discovery XML/txt) MUST immediately return 503 + no-store + noindex, nofollow
    for (const path of ["/", "/layanan/audit-gedung", "/robots.txt", "/sitemap.xml", "/sitemaps/pages.xml"]) {
      const suspRes = await crawlFetch(`${originA}${path}`);
      expect(suspRes.status, `Suspended ${path} must return 503`).toBe(503);
      expect(suspRes.headers.get("cache-control")).toBe("no-store");
      expect(suspRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(suspRes.headers.get("retry-after")).toBeTruthy();
      expect(suspRes.headers.get("x-punyasitus-cache")).toBeNull();
      const body = await suspRes.text();
      expect(body).not.toContain(TENANT_A.name);
      expect(body).not.toContain("audit-gedung");
      expect(body).not.toContain("canonical");
      expect(body).not.toContain("<sitemapindex");
      expect(body).not.toContain("<urlset");
    }

    // Restore active and verify clean recovery
    await pDb
      .update(tenants)
      .set({ status: "active", updatedAt: new Date(BASE_TIME + 302_000) })
      .where(eq(tenants.id, TENANT_A.id));
    clearHostResolutionCache();

    const resumed = await crawlFetch(`${originA}/`);
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).toContain(TENANT_A.name);
  });

  it("enforces custom theme grant isolation and shared head/schema policy between Tenant A and Tenant B", async () => {
    await promoteTenantAToCustomDomain(BASE_TIME + 400_000);
    const routeDeps: PublicRouteDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      platformDomain: "punyasitus.com",
      saasZone: "situsku.click",
      nowMs: BASE_TIME + 400_500,
      bypassHostCache: true,
    };
    const alphaPage = await resolvePublicPageRoute(
      new Request(`https://${TENANT_A.customDomain}/`),
      routeDeps,
      "",
    );
    expect(alphaPage.kind).toBe("page");
    if (alphaPage.kind !== "page") return;

    const grantedContract = buildPublicThemeRouteShellContract({
      entitlement: {
        tenantId: TENANT_A.id,
        tenantStatus: "active",
        requestedThemeId: SAMPLE_AGENCY_THEME_ID,
        tenantGrants: [
          { tenantId: TENANT_A.id, themeId: SAMPLE_AGENCY_THEME_ID, active: true, grantedBy: "op_1" },
        ],
      },
      routeKind: "home",
      pathname: "/",
      shell: alphaPage.shell,
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: {
          tenantHandle: TENANT_A.handle,
          tenantStatus: "active",
          operatorHold: false,
          primaryHost: TENANT_A.customDomain,
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: [TENANT_A.customDomain, TENANT_A.subdomain],
          servingHost: TENANT_A.customDomain,
        },
        siteVisibility: "public",
        resourceState: "published",
      },
    });
    expect(grantedContract.resolution.fallbackUsed).toBe(false);
    expect(grantedContract.resolution.resolvedTheme.id).toBe(SAMPLE_AGENCY_THEME_ID);
    expect(grantedContract.seoMetadata.canonical).toBe(`https://${TENANT_A.customDomain}/`);
    expect(grantedContract.schemaGraph).not.toBeNull();

    // Ungranted Tenant B MUST fall back cleanly to `compro` without leaking Tenant A's theme
    const ungrantedContract = buildPublicThemeRouteShellContract({
      entitlement: {
        tenantId: TENANT_B.id,
        tenantStatus: "trial",
        requestedThemeId: SAMPLE_AGENCY_THEME_ID,
        tenantGrants: [
          { tenantId: TENANT_A.id, themeId: SAMPLE_AGENCY_THEME_ID, active: true, grantedBy: "op_1" },
        ],
      },
      routeKind: "home",
      pathname: "/",
      shell: {
        ...alphaPage.shell,
        site: { ...alphaPage.shell.site, title: TENANT_B.name },
        business: { ...alphaPage.shell.business, name: TENANT_B.name },
      },
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: {
          tenantHandle: TENANT_B.handle,
          tenantStatus: "trial",
          operatorHold: false,
          primaryHost: TENANT_B.subdomain,
          primaryHostKind: "subdomain",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: [TENANT_B.subdomain],
          servingHost: TENANT_B.subdomain,
        },
        siteVisibility: "public",
        resourceState: "published",
      },
    });
    expect(ungrantedContract.resolution.fallbackUsed).toBe(true);
    expect(ungrantedContract.resolution.resolvedTheme.id).toBe("compro");
    expect(ungrantedContract.seoMetadata.robots).toBe("noindex, nofollow");
  });
});
