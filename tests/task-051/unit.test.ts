import {
  AI_TRAINING_ONLY_CRAWLERS,
  ALLOWED_SEARCH_AND_AI_FETCHERS,
  INDEXABLE_NOFOLLOW_ROBOTS_DIRECTIVES,
  INDEXABLE_ROBOTS_DIRECTIVES,
  MAX_SEO_DESCRIPTION_LENGTH,
  MAX_SEO_TITLE_LENGTH,
  SeoPolicyError,
  buildRobotsTxtPolicy,
  escapeHtmlAttribute,
  escapeHtmlText,
  escapeXmlText,
  normalizeCanonicalUrl,
  resolveEffectiveSeoText,
  resolvePublishedSeoDecision,
  resolveVerifiedCanonicalOrigin,
  safeJsonLdStringify,
  sanitizeSeoDescription,
  sanitizeSeoText,
  sanitizeSeoTitle,
  validateCanonicalHostname,
  validateCanonicalOrigin,
  validateCanonicalOverride,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
import { describe, expect, it } from "vitest";

const ACTIVE_CUSTOM_TENANT: VerifiedTenantHostInput = {
  tenantHandle: "alpha-studio",
  tenantStatus: "active",
  primaryHost: "www.alphastudio.id",
  primaryHostKind: "custom",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.alphastudio.id", "alpha-studio.situsku.click"],
};

const TRIAL_TENANT: VerifiedTenantHostInput = {
  tenantHandle: "beta-trial",
  tenantStatus: "trial",
  primaryHost: "beta-trial.situsku.click",
  primaryHostKind: "subdomain",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
};

describe("TASK-051: Verified Primary Origin Resolution", () => {
  it("resolves verified active custom domain for paid tenants and falls back to *.situsku.click otherwise", () => {
    const custom = resolveVerifiedCanonicalOrigin(ACTIVE_CUSTOM_TENANT);
    expect(custom).toEqual({
      origin: "https://www.alphastudio.id",
      hostname: "www.alphastudio.id",
      hostKind: "custom",
      fallbackSubdomain: "alpha-studio.situsku.click",
      isAliasRequest: false,
      aliasRedirectStatus: null,
    });

    // Unverified/pending custom host falls back safely to *.situsku.click
    const pendingCustom = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostStatus: "pending",
    });
    expect(pendingCustom.origin).toBe("https://alpha-studio.situsku.click");
    expect(pendingCustom.hostKind).toBe("subdomain");

    const pendingSsl = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostSslStatus: "pending_validation",
    });
    expect(pendingSsl.origin).toBe("https://alpha-studio.situsku.click");

    const notVerifiedFlag = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostVerified: false,
    });
    expect(notVerifiedFlag.origin).toBe("https://alpha-studio.situsku.click");

    // Fail-closed: omitting (undefined/null) ANY verification proof falls back to *.situsku.click
    const omittedStatus = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostStatus: undefined,
    });
    expect(omittedStatus.origin).toBe("https://alpha-studio.situsku.click");
    expect(omittedStatus.hostKind).toBe("subdomain");

    const nullStatus = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostStatus: null,
    });
    expect(nullStatus.origin).toBe("https://alpha-studio.situsku.click");

    const omittedSsl = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostSslStatus: undefined,
    });
    expect(omittedSsl.origin).toBe("https://alpha-studio.situsku.click");

    const nullSsl = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostSslStatus: null,
    });
    expect(nullSsl.origin).toBe("https://alpha-studio.situsku.click");

    const omittedVerified = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostVerified: undefined,
    });
    expect(omittedVerified.origin).toBe("https://alpha-studio.situsku.click");

    const mismatchedKind = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      primaryHostKind: "subdomain",
    });
    expect(mismatchedKind.origin).toBe("https://alpha-studio.situsku.click");

    const omittedAllowlist = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      verifiedTenantHosts: undefined,
    });
    expect(omittedAllowlist.origin).toBe("https://alpha-studio.situsku.click");
    expect(omittedAllowlist.hostKind).toBe("subdomain");

    // Trial tenant is strictly *.situsku.click even if a custom host was passed
    const trialWithCustom = resolveVerifiedCanonicalOrigin({
      tenantHandle: "beta-trial",
      tenantStatus: "trial",
      primaryHost: "www.betatrial.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["www.betatrial.id", "beta-trial.situsku.click"],
    });
    expect(trialWithCustom.origin).toBe("https://beta-trial.situsku.click");
    expect(trialWithCustom.hostKind).toBe("subdomain");
  });

  it("detects secondary/alias hostname serving while custom primary is active", () => {
    const alias = resolveVerifiedCanonicalOrigin({
      ...ACTIVE_CUSTOM_TENANT,
      servingHost: "alpha-studio.situsku.click",
    });
    expect(alias.origin).toBe("https://www.alphastudio.id");
    expect(alias.isAliasRequest).toBe(true);
    expect(alias.aliasRedirectStatus).toBe(301);
  });

  it("rejects malicious hostnames and origins (schemes, IPs, ports, userinfo, CRLF, smuggling, foreign hosts)", () => {
    const badHostCases: readonly (readonly [string, string])[] = [
      ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
      ["data:text/html,<h1>x</h1>", "UNSUPPORTED_SCHEME"],
      ["http://www.alphastudio.id", "UNSUPPORTED_SCHEME"],
      ["https://www.alphastudio.id", "UNSUPPORTED_SCHEME"],
      ["127.0.0.1", "MALICIOUS_HOST"],
      ["127.1", "MALICIOUS_HOST"],
      ["10.1", "MALICIOUS_HOST"],
      ["1.1", "MALICIOUS_HOST"],
      ["0x7f.1", "MALICIOUS_HOST"],
      ["0x7f.0.0.1", "MALICIOUS_HOST"],
      ["0177.1", "MALICIOUS_HOST"],
      ["0177.0.0.1", "MALICIOUS_HOST"],
      ["169.254.169.254", "MALICIOUS_HOST"],
      ["192.168.1.10", "MALICIOUS_HOST"],
      ["8.8.8.8", "MALICIOUS_HOST"],
      ["2130706433", "MALICIOUS_HOST"],
      ["0x7f000001", "MALICIOUS_HOST"],
      ["example.123", "MALICIOUS_HOST"],
      ["[::1]", "MALICIOUS_HOST"],
      ["::1", "MALICIOUS_HOST"],
      ["www.alphastudio.id:8443", "FORBIDDEN_PORT"],
      ["www.alphastudio.id:443", "FORBIDDEN_PORT"],
      ["user:pass@www.alphastudio.id", "EMBEDDED_CREDENTIALS"],
      ["admin@www.alphastudio.id", "EMBEDDED_CREDENTIALS"],
      ["www.alphastudio.id\r\nX-Injected: 1", "CONTROL_CHARACTER"],
      ["www.alphastudio.id\nEvil: 1", "CONTROL_CHARACTER"],
      ["www.alphastudio.id/evil", "PATH_OR_QUERY_SMUGGLING"],
      ["www.alphastudio.id?host=evil", "PATH_OR_QUERY_SMUGGLING"],
      ["www.alphastudio.id#frag", "PATH_OR_QUERY_SMUGGLING"],
      ["www.alphastudio.id\\evil", "PATH_OR_QUERY_SMUGGLING"],
      ["*.alphastudio.id", "MALICIOUS_HOST"],
      ["localhost", "MALICIOUS_HOST"],
      ["service.internal", "MALICIOUS_HOST"],
      ["punyasitus.com", "MALICIOUS_HOST"],
      ["app.punyasitus.com", "MALICIOUS_HOST"],
      ["console.punyasitus.com", "MALICIOUS_HOST"],
      ["situsku.click", "MALICIOUS_HOST"],
      ["api.situsku.click", "MALICIOUS_HOST"],
    ];

    for (const [host, expectedCode] of badHostCases) {
      expect(() => validateCanonicalHostname(host)).toThrowError(SeoPolicyError);
      try {
        validateCanonicalHostname(host);
      } catch (err) {
        expect((err as SeoPolicyError).code).toBe(expectedCode);
      }
    }

    // Valid punycode RFC TLD is accepted
    expect(validateCanonicalHostname("toko.xn--p1ai")).toBe("toko.xn--p1ai");

    // Foreign tenant subdomain & foreign host outside verifiedTenantHosts
    expect(() =>
      resolveVerifiedCanonicalOrigin({
        ...ACTIVE_CUSTOM_TENANT,
        primaryHost: "other-tenant.situsku.click",
      }),
    ).toThrowError(SeoPolicyError);

    expect(() =>
      resolveVerifiedCanonicalOrigin({
        ...ACTIVE_CUSTOM_TENANT,
        primaryHost: "evil-hijack.com",
      }),
    ).toThrowError(SeoPolicyError);

    // validateCanonicalOrigin checks strict https:// and expectedOrigin match
    expect(validateCanonicalOrigin("https://WWW.AlphaStudio.ID")).toBe("https://www.alphastudio.id");
    expect(() => validateCanonicalOrigin("http://www.alphastudio.id")).toThrowError(SeoPolicyError);
    expect(() => validateCanonicalOrigin("javascript:alert(1)")).toThrowError(SeoPolicyError);
    expect(() => validateCanonicalOrigin("https://127.0.0.1")).toThrowError(SeoPolicyError);
    expect(() => validateCanonicalOrigin("https://www.alphastudio.id:8443")).toThrowError(SeoPolicyError);
    expect(() => validateCanonicalOrigin("https://user:pass@www.alphastudio.id")).toThrowError(SeoPolicyError);
    expect(() => validateCanonicalOrigin("https://www.alphastudio.id\r\nX: 1")).toThrowError(SeoPolicyError);
    expect(() => validateCanonicalOrigin("https://www.alphastudio.id/smuggled")).toThrowError(SeoPolicyError);
    expect(() =>
      validateCanonicalOrigin("https://foreign.com", "https://www.alphastudio.id"),
    ).toThrowError(SeoPolicyError);
  });
});

describe("TASK-051: Tenant Lifecycle & Surface Indexability Matrix (PLAN §15.2 / DESIGN §9)", () => {
  it("enforces ALWAYS noindex, nofollow and sitemapEligible=false for trial tenants", () => {
    const decision = resolvePublishedSeoDecision({
      routeKind: "homepage",
      pathname: "/",
      tenant: TRIAL_TENANT,
      resourceState: "published",
    });
    expect(decision.httpStatus).toBe(200);
    expect(decision.indexable).toBe(false);
    expect(decision.noindex).toBe(true);
    expect(decision.nofollow).toBe(true);
    expect(decision.robotsMeta).toBe("noindex, nofollow");
    expect(decision.xRobotsTag).toBe("noindex, nofollow");
    expect(decision.canonical).toBe("https://beta-trial.situsku.click/");
    expect(decision.sitemapEligible).toBe(false);
    expect(decision.reason).toBe("trial_tenant_noindex");
  });

  it("keeps active, grace (H+1..H+3), and locked (H+4..H+7) paid tenants live & indexable", () => {
    for (const status of ["active", "grace", "locked"] as const) {
      const decision = resolvePublishedSeoDecision({
        routeKind: "page",
        pathname: "/tentang-kami",
        tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: status },
        resourceState: "published",
      });
      expect(decision.httpStatus).toBe(200);
      expect(decision.indexable).toBe(true);
      expect(decision.noindex).toBe(false);
      expect(decision.nofollow).toBe(false);
      expect(decision.robotsMeta).toBe(INDEXABLE_ROBOTS_DIRECTIVES);
      expect(decision.canonical).toBe("https://www.alphastudio.id/tentang-kami");
      expect(decision.socialUrl).toBe("https://www.alphastudio.id/tentang-kami");
      expect(decision.sitemapEligible).toBe(true);
      expect(decision.reason).toBe("indexable_published");
    }
  });

  it("forces noindex, nofollow and canonical=null for suspended, recovery, operatorHold, destroyed, and purged", () => {
    const suspended = resolvePublishedSeoDecision({
      routeKind: "homepage",
      pathname: "/",
      tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "suspended" },
    });
    expect(suspended.httpStatus).toBe(503);
    expect(suspended.robotsMeta).toBe("noindex, nofollow");
    expect(suspended.canonical).toBeNull();
    expect(suspended.socialUrl).toBeNull();
    expect(suspended.sitemapEligible).toBe(false);
    expect(suspended.cacheControl).toBe("no-store");

    const operatorHold = resolvePublishedSeoDecision({
      routeKind: "homepage",
      pathname: "/",
      tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "active", operatorHold: true },
    });
    expect(operatorHold.httpStatus).toBe(503);
    expect(operatorHold.canonical).toBeNull();
    expect(operatorHold.sitemapEligible).toBe(false);

    const recovery = resolvePublishedSeoDecision({
      routeKind: "homepage",
      pathname: "/",
      tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "recovery" },
    });
    expect(recovery.httpStatus).toBe(503);
    expect(recovery.retryAfterSeconds).toBe(60);
    expect(recovery.canonical).toBeNull();
    expect(recovery.sitemapEligible).toBe(false);

    for (const deadStatus of ["destroyed", "purged", "purging", "provisioning"] as const) {
      const res = resolvePublishedSeoDecision({
        routeKind: "homepage",
        pathname: "/",
        tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: deadStatus },
      });
      expect(res.httpStatus).toBe(404);
      expect(res.robotsMeta).toBe("noindex, nofollow");
      expect(res.canonical).toBeNull();
      expect(res.sitemapEligible).toBe(false);
    }
  });

  it("never invents a canonical URL for draft/unpublished/trashed/missing, preview, private/admin/auth/API, error, or unknown-host routes", () => {
    for (const resourceState of ["draft", "unpublished", "trashed", "missing", "disabled"] as const) {
      const res = resolvePublishedSeoDecision({
        routeKind: "post",
        pathname: "/blog/rahasia-draft",
        tenant: ACTIVE_CUSTOM_TENANT,
        resourceState,
      });
      expect(res.httpStatus).toBe(404);
      expect(res.robotsMeta).toBe("noindex, nofollow");
      expect(res.canonical).toBeNull();
      expect(res.socialUrl).toBeNull();
      expect(res.sitemapEligible).toBe(false);
    }

    const privateCases = [
      { routeKind: "preview" as const, pathname: "/preview/42", surface: "preview" as const },
      { routeKind: "admin" as const, pathname: "/dashboard/alpha-studio/pages", surface: "app" as const },
      { routeKind: "auth" as const, pathname: "/auth/login", surface: "app" as const },
      { routeKind: "api" as const, pathname: "/api/tenants/alpha-studio/pages", surface: "api" as const },
      { routeKind: "private" as const, pathname: "/console/tenants", surface: "console" as const },
      // Even if caller accidentally passes routeKind="page", private path prefix still fails closed!
      { routeKind: "page" as const, pathname: "/dashboard/alpha-studio", surface: "public_tenant" as const },
      { routeKind: "page" as const, pathname: "/api/public/leads", surface: "public_tenant" as const },
      { routeKind: "page" as const, pathname: "/preview/draft-1", surface: "public_tenant" as const },
    ];
    for (const c of privateCases) {
      const res = resolvePublishedSeoDecision({
        routeKind: c.routeKind,
        surface: c.surface,
        pathname: c.pathname,
        tenant: ACTIVE_CUSTOM_TENANT,
      });
      expect(res.indexable).toBe(false);
      expect(res.robotsMeta).toBe("noindex, nofollow");
      expect(res.xRobotsTag).toBe("noindex, nofollow");
      expect(res.cacheControl).toBe("no-store");
      expect(res.canonical).toBeNull();
      expect(res.sitemapEligible).toBe(false);
    }

    for (const [routeKind, expectedStatus] of [
      ["error_404", 404],
      ["error_500", 500],
      ["error_503", 503],
      ["unknown_host", 404],
    ] as const) {
      const res = resolvePublishedSeoDecision({
        routeKind,
        pathname: "/broken",
        tenant: routeKind === "unknown_host" ? null : ACTIVE_CUSTOM_TENANT,
      });
      expect(res.httpStatus).toBe(expectedStatus);
      expect(res.robotsMeta).toBe("noindex, nofollow");
      expect(res.canonical).toBeNull();
      expect(res.sitemapEligible).toBe(false);
    }
  });

  it("handles alias host 301, former-slug 308, homepage-slug 308, site-wide noindex dominance, and archive/taxonomy rules", () => {
    // Verified alias host serving while primary custom domain is active
    const aliasDecision = resolvePublishedSeoDecision({
      routeKind: "page",
      pathname: "/layanan",
      tenant: { ...ACTIVE_CUSTOM_TENANT, servingHost: "alpha-studio.situsku.click" },
    });
    expect(aliasDecision.httpStatus).toBe(301);
    expect(aliasDecision.redirectStatus).toBe(301);
    expect(aliasDecision.indexable).toBe(false);
    expect(aliasDecision.noindex).toBe(true);
    expect(aliasDecision.robotsMeta).toBe("noindex, follow");
    expect(aliasDecision.xRobotsTag).toBe("noindex, follow");
    expect(aliasDecision.redirectTarget).toBe("https://www.alphastudio.id/layanan");
    expect(aliasDecision.canonical).toBe("https://www.alphastudio.id/layanan");
    expect(aliasDecision.sitemapEligible).toBe(false);

    // Former slug 308
    const formerSlug = resolvePublishedSeoDecision({
      routeKind: "former_slug",
      pathname: "/blog/judul-lama",
      redirectTargetPath: "/blog/judul-baru",
      tenant: ACTIVE_CUSTOM_TENANT,
    });
    expect(formerSlug.httpStatus).toBe(308);
    expect(formerSlug.redirectTarget).toBe("https://www.alphastudio.id/blog/judul-baru");
    expect(formerSlug.canonical).toBe("https://www.alphastudio.id/blog/judul-baru");
    expect(formerSlug.sitemapEligible).toBe(false);

    // Former slug MUST reject private/internal redirectTargetPath values
    for (const privateTarget of [
      "/api/tenants/alpha-studio/pages",
      "/dashboard/alpha-studio",
      "/auth/login",
      "/console/tenants",
      "/_astro/chunk.js",
      "/preview/42",
    ]) {
      expect(() =>
        resolvePublishedSeoDecision({
          routeKind: "former_slug",
          pathname: "/blog/judul-lama",
          redirectTargetPath: privateTarget,
          tenant: ACTIVE_CUSTOM_TENANT,
        }),
      ).toThrowError(SeoPolicyError);
    }

    // Homepage slug alias /{slug} -> 308 to /
    const homeAlias = resolvePublishedSeoDecision({
      routeKind: "homepage_slug_alias",
      pathname: "/beranda",
      tenant: ACTIVE_CUSTOM_TENANT,
    });
    expect(homeAlias.httpStatus).toBe(308);
    expect(homeAlias.redirectTarget).toBe("https://www.alphastudio.id/");
    expect(homeAlias.sitemapEligible).toBe(false);

    // Site-wide noindex dominates per-resource noindex=false
    const siteNoindex = resolvePublishedSeoDecision({
      routeKind: "page",
      pathname: "/tentang-kami",
      tenant: ACTIVE_CUSTOM_TENANT,
      siteVisibility: "noindex",
      resourceSeo: { noindex: false, nofollow: false },
    });
    expect(siteNoindex.httpStatus).toBe(200);
    expect(siteNoindex.indexable).toBe(false);
    expect(siteNoindex.robotsMeta).toBe("noindex, follow");
    expect(siteNoindex.canonical).toBe("https://www.alphastudio.id/tentang-kami");
    expect(siteNoindex.sitemapEligible).toBe(false);
    expect(siteNoindex.reason).toBe("site_wide_noindex");

    // Per-resource nofollow on indexable page
    const nofollowOnly = resolvePublishedSeoDecision({
      routeKind: "page",
      pathname: "/promo-partner",
      tenant: ACTIVE_CUSTOM_TENANT,
      resourceSeo: { noindex: false, nofollow: true },
    });
    expect(nofollowOnly.indexable).toBe(true);
    expect(nofollowOnly.robotsMeta).toBe(INDEXABLE_NOFOLLOW_ROBOTS_DIRECTIVES);

    // Empty blog index -> noindex, follow; non-empty -> indexable + sitemap eligible
    const emptyBlog = resolvePublishedSeoDecision({
      routeKind: "blog_index",
      pathname: "/blog",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 0,
    });
    expect(emptyBlog.indexable).toBe(false);
    expect(emptyBlog.robotsMeta).toBe("noindex, follow");
    expect(emptyBlog.sitemapEligible).toBe(false);

    const populatedBlog = resolvePublishedSeoDecision({
      routeKind: "blog_index",
      pathname: "/blog",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 12,
      totalPages: 2,
    });
    expect(populatedBlog.indexable).toBe(true);
    expect(populatedBlog.sitemapEligible).toBe(true);
    expect(populatedBlog.nextUrl).toBe("https://www.alphastudio.id/blog?page=2");

    // Category archive: default noindex unless opted-in with useful intro & published items
    const defaultCat = resolvePublishedSeoDecision({
      routeKind: "category_archive",
      pathname: "/blog/category/tips",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 5,
    });
    expect(defaultCat.indexable).toBe(false);
    expect(defaultCat.robotsMeta).toBe("noindex, follow");
    expect(defaultCat.sitemapEligible).toBe(false);

    const optedInCat = resolvePublishedSeoDecision({
      routeKind: "category_archive",
      pathname: "/blog/category/tips",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 5,
      taxonomyIndexOptIn: true,
      taxonomyHasUsefulIntro: true,
    });
    expect(optedInCat.indexable).toBe(true);
    expect(optedInCat.sitemapEligible).toBe(true);

    const optedInEmptyCat = resolvePublishedSeoDecision({
      routeKind: "category_archive",
      pathname: "/blog/category/kosong",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 0,
      taxonomyIndexOptIn: true,
      taxonomyHasUsefulIntro: true,
    });
    expect(optedInEmptyCat.indexable).toBe(false);
    expect(optedInEmptyCat.sitemapEligible).toBe(false);
  });
});

describe("TASK-051: Path, Pagination, Tracking, Faceted Filters & Canonical Override", () => {
  it("normalizes slashes, casing, tracking params, and pagination (page=1 vs page=2+)", () => {
    // Trailing slash & collapsed double slashes
    const normalized = normalizeCanonicalUrl({
      verifiedOrigin: "https://WWW.AlphaStudio.ID",
      pathname: "//Layanan///Jasa-AC//",
      query: "utm_source=google&utm_medium=cpc&fbclid=fb123&gclid=gc456&ttclid=tt789&ref=wa",
    });
    expect(normalized.canonicalUrl).toBe("https://www.alphastudio.id/layanan/jasa-ac");
    expect(normalized.needsPathOrPageOneRedirect).toBe(true);
    expect(normalized.strippedTrackingParams).toEqual([
      "utm_source",
      "utm_medium",
      "fbclid",
      "gclid",
      "ttclid",
      "ref",
    ]);

    // Root keeps trailing slash
    const root = normalizeCanonicalUrl({
      verifiedOrigin: "https://www.alphastudio.id",
      pathname: "/",
    });
    expect(root.canonicalUrl).toBe("https://www.alphastudio.id/");
    expect(root.needsPathOrPageOneRedirect).toBe(false);

    // page=1 is dropped with 308 redirect signal
    const page1 = resolvePublishedSeoDecision({
      routeKind: "blog_index",
      pathname: "/blog",
      query: "page=1&utm_source=chatgpt.com",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 25,
      totalPages: 3,
    });
    expect(page1.canonical).toBe("https://www.alphastudio.id/blog");
    expect(page1.redirectStatus).toBe(308);
    expect(page1.redirectTarget).toBe("https://www.alphastudio.id/blog");
    expect(page1.pageNumber).toBe(1);

    // page=2 is retained as self canonical, excluded from sitemap, with prev/next links
    const page2 = resolvePublishedSeoDecision({
      routeKind: "blog_index",
      pathname: "/blog",
      query: "page=2&utm_campaign=launch",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 25,
      totalPages: 3,
    });
    expect(page2.httpStatus).toBe(200);
    expect(page2.indexable).toBe(true);
    expect(page2.canonical).toBe("https://www.alphastudio.id/blog?page=2");
    expect(page2.sitemapEligible).toBe(false);
    expect(page2.prevUrl).toBe("https://www.alphastudio.id/blog");
    expect(page2.nextUrl).toBe("https://www.alphastudio.id/blog?page=3");

    // Out-of-range page -> 404, noindex, nofollow, canonical: null
    const outOfRange = resolvePublishedSeoDecision({
      routeKind: "blog_index",
      pathname: "/blog",
      query: "page=9",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 25,
      totalPages: 3,
    });
    expect(outOfRange.httpStatus).toBe(404);
    expect(outOfRange.robotsMeta).toBe("noindex, nofollow");
    expect(outOfRange.canonical).toBeNull();
    expect(outOfRange.sitemapEligible).toBe(false);

    // Malformed & duplicate page params -> 400, noindex, nofollow, canonical: null
    for (const badQuery of ["page=0", "page=-2", "page=abc", "page=01", "page=2&page=3"]) {
      const invalid = resolvePublishedSeoDecision({
        routeKind: "blog_index",
        pathname: "/blog",
        query: badQuery,
        tenant: ACTIVE_CUSTOM_TENANT,
        publishedItemCount: 25,
        totalPages: 3,
      });
      expect(invalid.httpStatus).toBe(400);
      expect(invalid.canonical).toBeNull();
      expect(invalid.robotsMeta).toBe("noindex, nofollow");
    }
  });

  it("marks multi-parameter faceted filters on /kendaraan & /produk as noindex, follow with base archive canonical", () => {
    const vehicleFaceted = resolvePublishedSeoDecision({
      routeKind: "catalog_index",
      pathname: "/kendaraan",
      query: "brand=toyota&transmission=automatic&year=2024",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 15,
    });
    expect(vehicleFaceted.httpStatus).toBe(200);
    expect(vehicleFaceted.indexable).toBe(false);
    expect(vehicleFaceted.noindex).toBe(true);
    expect(vehicleFaceted.nofollow).toBe(false);
    expect(vehicleFaceted.robotsMeta).toBe("noindex, follow");
    expect(vehicleFaceted.canonical).toBe("https://www.alphastudio.id/kendaraan");
    expect(vehicleFaceted.sitemapEligible).toBe(false);
    expect(vehicleFaceted.isFacetedFilter).toBe(true);

    const productFaceted = resolvePublishedSeoDecision({
      routeKind: "catalog_index",
      pathname: "/produk",
      query: "category=kopi&min_price=50000&sort=price_asc",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 20,
    });
    expect(productFaceted.httpStatus).toBe(200);
    expect(productFaceted.robotsMeta).toBe("noindex, follow");
    expect(productFaceted.canonical).toBe("https://www.alphastudio.id/produk");
    expect(productFaceted.sitemapEligible).toBe(false);
    expect(productFaceted.isFacetedFilter).toBe(true);

    // Search/sort altered result set omits canonical per PLAN §15.2
    const searchQuery = resolvePublishedSeoDecision({
      routeKind: "blog_index",
      pathname: "/blog",
      query: "q=sewa+mobil",
      tenant: ACTIVE_CUSTOM_TENANT,
      publishedItemCount: 10,
    });
    expect(searchQuery.httpStatus).toBe(200);
    expect(searchQuery.robotsMeta).toBe("noindex, follow");
    expect(searchQuery.canonical).toBeNull();
    expect(searchQuery.sitemapEligible).toBe(false);
  });

  it("validates optional owner canonicalOverride and rejects cross-origin/script/malicious injection", () => {
    expect(
      validateCanonicalOverride(
        "https://www.alphastudio.id/layanan/paket-utama/?utm_source=ads#top",
        "https://www.alphastudio.id",
      ),
    ).toBe("https://www.alphastudio.id/layanan/paket-utama");

    expect(
      validateCanonicalOverride("/layanan/paket-utama/", "https://www.alphastudio.id"),
    ).toBe("https://www.alphastudio.id/layanan/paket-utama");

    // Non-self canonical override excludes duplicate route from sitemap
    const withOverride = resolvePublishedSeoDecision({
      routeKind: "page",
      pathname: "/promo-duplicate",
      canonicalOverride: "https://www.alphastudio.id/layanan/paket-utama",
      tenant: ACTIVE_CUSTOM_TENANT,
    });
    expect(withOverride.canonical).toBe("https://www.alphastudio.id/layanan/paket-utama");
    expect(withOverride.sitemapEligible).toBe(false);

    const maliciousOverrides = [
      "https://evil.com/phishing",
      "https://beta-trial.situsku.click/steal",
      "http://www.alphastudio.id/insecure",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "//evil.com/protocol-relative",
      "https://user:pass@www.alphastudio.id/auth",
      "https://www.alphastudio.id:8443/port",
      "https://www.alphastudio.id/dashboard/alpha-studio",
      "https://www.alphastudio.id/api/tenants/alpha-studio",
      "https://www.alphastudio.id/preview/1",
      "https://www.alphastudio.id/page\r\nInjected: 1",
      "https://www.alphastudio.id/a/../../etc/passwd",
      'https://www.alphastudio.id/"><script>alert(1)</script>',
    ];

    for (const bad of maliciousOverrides) {
      expect(() =>
        validateCanonicalOverride(bad, "https://www.alphastudio.id"),
      ).toThrowError(SeoPolicyError);
    }
  });
});

describe("TASK-051: Safe Meta Escaping, Length Caps & JSON-LD Serialization", () => {
  it("strips control characters, collapses whitespace, and caps titles (<=70) & descriptions (<=160)", () => {
    expect(sanitizeSeoText("  Halo\x00\r\n  Dunia\t!  ")).toBe("Halo Dunia !");

    const longTitle = "A".repeat(120);
    expect(sanitizeSeoTitle(longTitle).length).toBeLessThanOrEqual(MAX_SEO_TITLE_LENGTH);
    expect(sanitizeSeoTitle(longTitle).length).toBe(70);

    const longDesc = "Deskripsi bisnis lengkap ".repeat(20);
    expect(sanitizeSeoDescription(longDesc).length).toBeLessThanOrEqual(MAX_SEO_DESCRIPTION_LENGTH);

    const effective = resolveEffectiveSeoText({
      resourceTitle: "Artikel Panduan",
      siteTitle: "Alpha Studio",
      pageNumber: 2,
      resourceExcerpt: "Ringkasan\x07 artikel\nbaru untuk UMKM Indonesia.",
    });
    expect(effective.title).toBe("Artikel Panduan | Halaman 2 | Alpha Studio");
    expect(effective.description).toBe("Ringkasan artikel baru untuk UMKM Indonesia.");
  });

  it("escapes HTML attributes, HTML text, XML text, and neutralizes </script> / <!-- / --> in JSON-LD", () => {
    const malicious = '"><script>alert(1)</script><!--comment-->&\'test';

    const attrEscaped = escapeHtmlAttribute(malicious);
    expect(attrEscaped).not.toContain("<");
    expect(attrEscaped).not.toContain(">");
    expect(attrEscaped).not.toContain('"');
    expect(attrEscaped).toContain("&quot;");
    expect(attrEscaped).toContain("&lt;script&gt;");
    expect(attrEscaped).toContain("&amp;");
    expect(attrEscaped).toContain("&#39;");

    expect(escapeHtmlText(malicious)).toBe(attrEscaped);
    expect(escapeXmlText("A & B <C> \"D\" 'E'")).toBe("A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;");
    // XML 1.0 safety: strips U+FFFE, U+FFFF, lone UTF-16 surrogates, while preserving valid surrogate pairs (emoji)
    expect(escapeXmlText("Valid\uFFFE\uFFFF\uD800A\uDC00🚀End")).toBe("ValidA🚀End");

    const jsonLdPayload = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: 'Alpha </script><script>alert("xss")</script> <!-- --> & Co',
      description: "Line\u2028Break\u2029End",
    };
    const safeJson = safeJsonLdStringify(jsonLdPayload);
    expect(safeJson).not.toContain("</script>");
    expect(safeJson).not.toContain("<script>");
    expect(safeJson).not.toContain("<!--");
    expect(safeJson).not.toContain("-->");
    expect(safeJson).not.toContain("\u2028");
    expect(safeJson).not.toContain("\u2029");
    // Must remain 100% valid JSON that round-trips identically
    expect(JSON.parse(safeJson)).toEqual(jsonLdPayload);
  });
});

describe("TASK-051: Managed robots.txt & AI Crawler Policy (REQ-025, REQ-095)", () => {
  it("allows documented search & AI fetchers, honors aiTrainingPolicy allow vs disallow, and disallows private + faceted URLs", () => {
    const allowed = buildRobotsTxtPolicy({
      tenant: ACTIVE_CUSTOM_TENANT,
      aiTrainingPolicy: "allow",
    });
    expect(allowed.httpStatus).toBe(200);
    expect(allowed.indexable).toBe(true);
    expect(allowed.sitemapUrl).toBe("https://www.alphastudio.id/sitemap.xml");
    expect(allowed.body).toContain("Sitemap: https://www.alphastudio.id/sitemap.xml");
    expect(allowed.body).toContain("Disallow: /api/");
    expect(allowed.body).toContain("Disallow: /dashboard/");
    expect(allowed.body).toContain("Disallow: /preview");
    expect(allowed.body).toContain("Disallow: /kendaraan?*&*");
    expect(allowed.body).toContain("Disallow: /produk?*&*");
    for (const bot of ALLOWED_SEARCH_AND_AI_FETCHERS) {
      expect(allowed.body).toContain(`User-agent: ${bot}`);
    }
    for (const bot of AI_TRAINING_ONLY_CRAWLERS) {
      expect(allowed.body).toContain(`User-agent: ${bot}`);
    }
    expect(allowed.body).not.toMatch(/User-agent: Applebot-Extended\nDisallow: \//);

    const disallowedTraining = buildRobotsTxtPolicy({
      tenant: ACTIVE_CUSTOM_TENANT,
      aiTrainingPolicy: "disallow",
    });
    expect(disallowedTraining.httpStatus).toBe(200);
    expect(disallowedTraining.body).toContain("User-agent: OAI-SearchBot");
    expect(disallowedTraining.body).toContain("User-agent: Claude-SearchBot");
    expect(disallowedTraining.body).toContain("User-agent: PerplexityBot");
    expect(disallowedTraining.body).toContain(
      "User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nUser-agent: Applebot-Extended\nDisallow: /",
    );
    expect(disallowedTraining.body).toContain("Sitemap: https://www.alphastudio.id/sitemap.xml");
  });

  it("emits Disallow: / with no Sitemap for trial, noindex, suspended, and 404 for destroyed; keeps grace & locked indexable", () => {
    const trialRobots = buildRobotsTxtPolicy({ tenant: TRIAL_TENANT });
    expect(trialRobots.httpStatus).toBe(200);
    expect(trialRobots.indexable).toBe(false);
    expect(trialRobots.sitemapUrl).toBeNull();
    expect(trialRobots.body).toBe("User-agent: *\nDisallow: /\n");

    const siteNoindexRobots = buildRobotsTxtPolicy({
      tenant: ACTIVE_CUSTOM_TENANT,
      siteVisibility: "noindex",
    });
    expect(siteNoindexRobots.httpStatus).toBe(200);
    expect(siteNoindexRobots.sitemapUrl).toBeNull();
    expect(siteNoindexRobots.body).toBe("User-agent: *\nDisallow: /\n");

    const suspendedRobots = buildRobotsTxtPolicy({
      tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "suspended" },
    });
    expect(suspendedRobots.httpStatus).toBe(503);
    expect(suspendedRobots.sitemapUrl).toBeNull();
    expect(suspendedRobots.body).toBe("User-agent: *\nDisallow: /\n");

    const destroyedRobots = buildRobotsTxtPolicy({
      tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "destroyed" },
    });
    expect(destroyedRobots.httpStatus).toBe(404);
    expect(destroyedRobots.sitemapUrl).toBeNull();
    expect(destroyedRobots.body).toBe("");

    // Grace and Locked remain indexable with Sitemap pointing to primary origin
    for (const status of ["grace", "locked"] as const) {
      const res = buildRobotsTxtPolicy({
        tenant: {
          ...ACTIVE_CUSTOM_TENANT,
          tenantStatus: status,
          servingHost: "alpha-studio.situsku.click", // even when hit on alias host!
        },
      });
      expect(res.httpStatus).toBe(200);
      expect(res.indexable).toBe(true);
      expect(res.sitemapUrl).toBe("https://www.alphastudio.id/sitemap.xml");
      expect(res.body).toContain("Sitemap: https://www.alphastudio.id/sitemap.xml");
    }
  });
});
