import fs from "node:fs";
import path from "node:path";
import {
  generateOpenGraphMetadata,
  renderSeoHeadHtml,
} from "@punyasitus/core/og-generator";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import {
  buildRobotsTxtPolicy,
  resolvePublishedSeoDecision,
  resolveVerifiedCanonicalOrigin,
  SeoPolicyError,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
import { composePublicSeoHead } from "@punyasitus/core/seo/local-entity";
import { isPathAllowedByRobotsTxt } from "@punyasitus/core/seo/robots";
import { describe, expect, it } from "vitest";
import { buildSafeThemeStyleBlock } from "../../apps/web/src/core/public-data.ts";
import {
  auditCustomThemeSourceFiles,
  buildPublicThemeRouteShellContract,
} from "../../apps/web/src/core/theme-registry.ts";
import {
  buildSitemapIndexXml,
  buildUrlsetXml,
  chunkSitemapUrlEntries,
  MAX_SITEMAP_UNCOMPRESSED_BYTES,
  MAX_SITEMAP_URLS_PER_FILE,
  parseSubSitemapParam,
  type SitemapUrlEntry,
} from "../../apps/web/src/pages/sitemaps/_shared.ts";
import { SAMPLE_AGENCY_THEME_ID } from "../../apps/web/src/themes/custom/sample-agency/theme.ts";
import {
  auditHttpCrawlPage,
  auditInternalLinksOverHttp,
  auditSitemapIndexXml,
  auditUrlsetXml,
  evaluateRobotsHeaderMetaParity,
  extractDocumentLinks,
  findCrossTenantLeaks,
  parseRobotsTxt,
  parseStrictCrawlXml,
} from "./crawl-audit.ts";

const TENANT_A_ACTIVE: VerifiedTenantHostInput = {
  tenantHandle: "alpha-studio",
  tenantStatus: "active",
  operatorHold: false,
  primaryHost: "www.alpha-studio.id",
  primaryHostKind: "custom",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.alpha-studio.id", "alpha-studio.situsku.click"],
  servingHost: "www.alpha-studio.id",
};

const TENANT_A_ALIAS: VerifiedTenantHostInput = {
  ...TENANT_A_ACTIVE,
  servingHost: "alpha-studio.situsku.click",
};

const TENANT_B_TRIAL: VerifiedTenantHostInput = {
  tenantHandle: "beta-trial",
  tenantStatus: "trial",
  operatorHold: false,
  primaryHost: "beta-trial.situsku.click",
  primaryHostKind: "subdomain",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["beta-trial.situsku.click"],
  servingHost: "beta-trial.situsku.click",
};

const TENANT_SUSPENDED: VerifiedTenantHostInput = {
  ...TENANT_A_ACTIVE,
  tenantStatus: "suspended",
};

describe("TASK-054 unit — Crawl Audit Helpers, XML/Head/JSON-LD/Robots Parsers & PLAN §15 Policy Matrix", () => {
  describe("1. Strict XML, W3C Datetime, Namespaces & Sitemap Limits (<= 50,000 URLs & <= 50 MB)", () => {
    it("parses valid sitemapindex/urlset XML (including W3C dates) and rejects unescaped entities, invalid codepoints, and undeclared prefixes", () => {
      const validIndexXml = buildSitemapIndexXml([
        { loc: "https://www.alpha-studio.id/sitemaps/pages.xml", lastmod: "2026-11-20T08:00:00.000Z" },
        { loc: "https://www.alpha-studio.id/sitemaps/posts.xml", lastmod: "2026-11-21" },
      ]);
      const idxAudit = auditSitemapIndexXml(validIndexXml, "https://www.alpha-studio.id");
      expect(idxAudit.entries).toHaveLength(2);
      expect(idxAudit.duplicateLocs).toEqual([]);
      expect(idxAudit.foreignOriginLocs).toEqual([]);
      expect(idxAudit.invalidLastmods).toEqual([]);
      expect(idxAudit.exceedsUrlLimit).toBe(false);
      expect(idxAudit.exceedsByteLimit).toBe(false);

      const validUrlsetXml = buildUrlsetXml([
        { loc: "https://www.alpha-studio.id/", lastmod: "2026-11-20T08:00:00+07:00" },
        { loc: "https://www.alpha-studio.id/layanan/audit", lastmod: "2026-11-21T09:30:00Z" },
      ]);
      const urlAudit = auditUrlsetXml(validUrlsetXml, "https://www.alpha-studio.id");
      expect(urlAudit.entries).toHaveLength(2);
      expect(urlAudit.duplicateLocs).toEqual([]);
      expect(urlAudit.foreignOriginLocs).toEqual([]);
      expect(urlAudit.invalidLastmods).toEqual([]);
      expect(urlAudit.paginatedOrTrackedLocs).toEqual([]);

      // Negative XML cases: unescaped '&', out-of-range numeric ref (structured error, not RangeError), undeclared namespace prefix
      expect(() =>
        parseStrictCrawlXml(
          '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://a.id/?a=1&b=2</loc></url></urlset>',
        ),
      ).toThrow(/Unescaped '&'/);

      expect(() =>
        parseStrictCrawlXml(
          '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>&#999999999;</loc></url></urlset>',
        ),
      ).toThrow(/Invalid XML numeric character reference/);

      expect(() =>
        parseStrictCrawlXml(
          '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.id/</loc><image:image><image:loc>https://media.punyasitus.com/a.webp</image:loc></image:image></url></urlset>',
        ),
      ).toThrow(/Undeclared XML namespace prefix 'image'/);

      const badUrlset =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "  <url><loc>https://www.alpha-studio.id/</loc><lastmod>not-a-date</lastmod></url>\n" +
        "  <url><loc>https://www.alpha-studio.id/</loc></url>\n" +
        "  <url><loc>https://beta-trial.situsku.click/leaked</loc></url>\n" +
        "  <url><loc>https://www.alpha-studio.id/blog?page=2</loc></url>\n" +
        "</urlset>\n";
      const badAudit = auditUrlsetXml(badUrlset, "https://www.alpha-studio.id");
      expect(badAudit.duplicateLocs).toEqual(["https://www.alpha-studio.id/"]);
      expect(badAudit.foreignOriginLocs).toEqual(["https://beta-trial.situsku.click/leaked"]);
      expect(badAudit.invalidLastmods).toEqual(["not-a-date"]);
      expect(badAudit.paginatedOrTrackedLocs).toEqual(["https://www.alpha-studio.id/blog?page=2"]);
    });

    it("enforces sitemap 50,000-URL and 50 MB uncompressed chunking boundaries", () => {
      expect(MAX_SITEMAP_URLS_PER_FILE).toBe(50_000);
      expect(MAX_SITEMAP_UNCOMPRESSED_BYTES).toBe(50_000_000);

      const largeEntries: SitemapUrlEntry[] = Array.from({ length: 50_001 }, (_, idx) => ({
        loc: `https://www.alpha-studio.id/blog/post-${idx + 1}`,
        lastmod: "2026-11-20T08:00:00.000Z",
      }));
      const countChunks = chunkSitemapUrlEntries(largeEntries);
      expect(countChunks).toHaveLength(2);
      expect(countChunks[0]).toHaveLength(50_000);
      expect(countChunks[1]).toHaveLength(1);

      const byteEntries: SitemapUrlEntry[] = Array.from({ length: 20 }, (_, idx) => ({
        loc: `https://www.alpha-studio.id/layanan/paket-konsultasi-panjang-${idx + 1}`,
        lastmod: "2026-11-20T08:00:00.000Z",
      }));
      const byteChunks = chunkSitemapUrlEntries(byteEntries, { maxBytes: 900 });
      expect(byteChunks.length).toBeGreaterThan(2);
      for (const chunk of byteChunks) {
        const xml = buildUrlsetXml(chunk);
        const audited = auditUrlsetXml(xml, "https://www.alpha-studio.id", { maxBytes: 900 });
        expect(audited.exceedsByteLimit).toBe(false);
        expect(audited.exceedsUrlLimit).toBe(false);
      }

      expect(parseSubSitemapParam("pages")).toEqual({ kind: "pages", chunkIndex: 1 });
      expect(parseSubSitemapParam("pages-2.xml")).toEqual({ kind: "pages", chunkIndex: 2 });
      expect(parseSubSitemapParam("pages-1")).toBeNull();
      expect(parseSubSitemapParam("unknown")).toBeNull();
    });
  });

  describe("2. RFC 9309 `robots.txt` Parser, HTML `<head>` / Whole-Document XSS, `X-Robots-Tag`, JSON-LD & Link Auditors", () => {
    it("parses RFC 9309 robots.txt groups correctly with and without blank lines", () => {
      const noBlankLine = [
        "User-agent: GPTBot",
        "Disallow: /",
        "User-agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Sitemap: https://www.alpha-studio.id/sitemap.xml",
      ].join("\n");
      const parsedNoBlank = parseRobotsTxt(noBlankLine);
      expect(parsedNoBlank.disallowAllWildcard).toBe(false);
      expect(parsedNoBlank.rulesByAgent["gptbot"]).toEqual([{ directive: "disallow", value: "/" }]);
      expect(parsedNoBlank.rulesByAgent["*"]).toEqual([
        { directive: "allow", value: "/" },
        { directive: "disallow", value: "/api/" },
      ]);
      expect(parsedNoBlank.sitemaps).toEqual(["https://www.alpha-studio.id/sitemap.xml"]);

      const withBlankLine = [
        "User-agent: GPTBot",
        "User-agent: CCBot",
        "Disallow: /",
        "",
        "User-agent: *",
        "Allow: /",
      ].join("\n");
      const parsedWithBlank = parseRobotsTxt(withBlankLine);
      expect(parsedWithBlank.disallowAllWildcard).toBe(false);
      expect(parsedWithBlank.rulesByAgent["gptbot"]).toEqual([{ directive: "disallow", value: "/" }]);
      expect(parsedWithBlank.rulesByAgent["ccbot"]).toEqual([{ directive: "disallow", value: "/" }]);
      expect(parsedWithBlank.rulesByAgent["*"]).toEqual([{ directive: "allow", value: "/" }]);
    });

    it("detects duplicate <title>, duplicate/contradictory robots (including none/all/bot-prefixed X-Robots-Tag), unquoted JSON-LD, foreign media URLs, and whole-document body XSS", () => {
      const brokenHtml = `<!doctype html><html><head>
        <title>First</title><title>Second</title>
        <meta name="description" content="Desc 1" />
        <meta name="description" content="Desc 2" />
        <meta name="robots" content="index, follow" />
        <meta name="robots" content="noindex, nofollow" />
        <link rel="canonical" href="https://www.alpha-studio.id/layanan?utm_source=fb&fbclid=abc" />
        <script type=application/ld+json>{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Evil","logo":"https://evil.foreign.example/logo.png","offers":{"@type":"Offer","price":100}}]}</script>
      </head><body><h1 onclick=alert(1)>Test</h1><a href="javascript:alert(2)">Bad</a></body></html>`;

      const audit = auditHttpCrawlPage({
        url: "https://www.alpha-studio.id/layanan",
        status: 200,
        html: brokenHtml,
        xRobotsTagHeader: "googlebot: noindex",
        expectedOrigin: "https://www.alpha-studio.id",
        expectNoOffers: true,
      });
      expect(audit.titleCount).toBe(2);
      expect(audit.descriptionCount).toBe(2);
      expect(audit.robotsMetaCount).toBe(2);
      expect(audit.robotsParity.consistent).toBe(false);
      expect(audit.canonicalHasTrackingParams).toBe(true);
      expect(audit.jsonLdCount).toBe(1);
      expect(audit.jsonLdForeignOriginUrls).toEqual(["https://evil.foreign.example/logo.png"]);
      expect(audit.hasUnexpectedOffers).toBe(true);
      expect(audit.hasUnescapedHtmlInjectionInHead).toBe(false);
      expect(audit.hasUnescapedHtmlInjectionInDocument).toBe(true);

      // Robots parity edge cases: `none`, `all`, bot-prefixed `googlebot: noindex`
      expect(evaluateRobotsHeaderMetaParity(["all"], "none").consistent).toBe(false);
      expect(evaluateRobotsHeaderMetaParity(["index, follow"], "googlebot: noindex").consistent).toBe(false);
      expect(evaluateRobotsHeaderMetaParity(["none"], "googlebot: noindex").consistent).toBe(true);
      expect(evaluateRobotsHeaderMetaParity(["noindex, follow"], "index, follow").consistent).toBe(false);
      expect(evaluateRobotsHeaderMetaParity(["noindex, follow"], "noindex, follow").consistent).toBe(true);
      expect(
        evaluateRobotsHeaderMetaParity(
          ["index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"],
          null,
        ).consistent,
      ).toBe(true);
    });

    it("escapes hostile `</script>` and attribute breakout payloads safely through composePublicSeoHead + generateSchemaGraph", () => {
      const hostileTitle = 'Studio "Evil" </title><script>alert(1)</script>';
      const hostileDesc = 'Konsultasi </script><img src=x onerror=alert(1)> & "terpercaya"';

      const seo = {
        surface: "public_tenant" as const,
        routeKind: "homepage" as const,
        pathname: "/",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public" as const,
        resourceState: "published" as const,
      };
      const metadata = generateOpenGraphMetadata({
        seo,
        tenantId: "t_alpha",
        siteName: hostileTitle,
        resourceTitle: hostileTitle,
        resourceExcerpt: hostileDesc,
        locale: "id-ID",
      });
      const schema = generateSchemaGraph({
        seo,
        tenantId: "t_alpha",
        siteName: hostileTitle,
        business: {
          businessName: hostileTitle,
          description: hostileDesc,
          businessCategory: "contractor",
          logo: {
            url: "https://media.punyasitus.com/t/t_alpha/media/logo.webp",
            width: 600,
            height: 200,
          },
        },
      });
      const composed = composePublicSeoHead({
        metadata,
        schemaGraph: schema.graph,
        seoAutopilotEnabled: true,
        publishedVerificationTokens: {
          google: "gscAlphaToken2026",
          bing: "0123456789ABCDEF",
          yandex: null,
        },
        blogEnabled: true,
        siteName: hostileTitle,
      });

      const fullHtml = `<!doctype html><html lang="id"><head><meta charset="utf-8" />${composed.html}</head><body><h1>Safe</h1></body></html>`;
      const audit = auditHttpCrawlPage({
        url: "https://www.alpha-studio.id/",
        status: 200,
        html: fullHtml,
        expectedOrigin: "https://www.alpha-studio.id",
        expectNoOffers: true,
      });

      expect(audit.titleCount).toBe(1);
      expect(audit.descriptionCount).toBeLessThanOrEqual(1);
      expect(audit.robotsMetaCount).toBe(1);
      expect(audit.robotsParity.consistent).toBe(true);
      expect(audit.canonicalCount).toBe(1);
      expect(audit.canonicalHref).toBe("https://www.alpha-studio.id/");
      expect(audit.jsonLdCount).toBe(1);
      expect(audit.jsonLdScripts[0]?.parseError).toBeNull();
      expect(audit.jsonLdScripts[0]?.hasRawScriptBreakout).toBe(false);
      expect(audit.hasUnescapedHtmlInjectionInHead).toBe(false);
      expect(audit.hasUnescapedHtmlInjectionInDocument).toBe(false);
      expect(audit.hasForbiddenSchemaProps).toBe(false);
      expect(audit.hasUnexpectedOffers).toBe(false);
      // Tenant's own media CDN logo is allowed; no foreign origin URLs
      expect(audit.jsonLdForeignOriginUrls).toEqual([]);
      expect(audit.verificationTokens).toEqual({
        google: "gscAlphaToken2026",
        bing: "0123456789ABCDEF",
      });
    });

    it("resolves relative hrefs against current page URL, ignores data-href, reads <link rel='next'>, and catches cross-tenant protocol-relative & broken links", async () => {
      const html = `<!doctype html><html><head>
        <link rel="next" href="?page=2" />
      </head><body>
        <a data-href="/fake-should-ignore" href=detail-a>Sibling</a>
        <a href="./nested">Nested</a>
        <a href="//beta-trial.situsku.click/steal">Protocol Relative Cross Tenant</a>
        <a href="https://beta-trial.situsku.click/leaked">Absolute Cross Tenant</a>
      </body></html>`;

      const extracted = extractDocumentLinks(
        html,
        "https://www.alpha-studio.id/blog/category/panduan",
        "https://www.alpha-studio.id",
      );
      expect(extracted.internalHrefs).toEqual([
        "/blog/category/detail-a",
        "/blog/category/nested",
        "/blog/category/panduan?page=2",
      ]);
      expect(extracted.foreignOriginLinks).toEqual([
        "https://beta-trial.situsku.click/steal",
        "https://beta-trial.situsku.click/leaked",
      ]);

      const routes: Record<string, Response> = {
        "https://www.alpha-studio.id/": new Response("ok", { status: 200 }),
        "https://www.alpha-studio.id/layanan/audit": new Response("ok", { status: 200 }),
        "https://www.alpha-studio.id/old-slug": new Response(null, {
          status: 308,
          headers: { Location: "https://www.alpha-studio.id/layanan/audit" },
        }),
        "https://www.alpha-studio.id/broken-page": new Response("not found", { status: 404 }),
      };

      const cleanAudit = await auditInternalLinksOverHttp({
        origin: "https://www.alpha-studio.id",
        pages: [{ url: "https://www.alpha-studio.id/", internalHrefs: ["/layanan/audit", "/old-slug"] }],
        forbiddenOrigins: ["https://beta-trial.situsku.click"],
        fetchRoute: async (url) => routes[url] ?? new Response("not found", { status: 404 }),
      });
      expect(cleanAudit.checkedCount).toBe(2);
      expect(cleanAudit.broken).toEqual([]);

      const brokenAudit = await auditInternalLinksOverHttp({
        origin: "https://www.alpha-studio.id",
        pages: [
          {
            url: "https://www.alpha-studio.id/",
            internalHrefs: ["/layanan/audit", "/broken-page"],
            foreignOriginLinks: ["https://beta-trial.situsku.click/steal"],
          },
        ],
        forbiddenOrigins: ["https://beta-trial.situsku.click"],
        fetchRoute: async (url) => routes[url] ?? new Response("not found", { status: 404 }),
      });
      expect(brokenAudit.broken).toHaveLength(2);
      expect(brokenAudit.broken.map((b) => b.href)).toEqual([
        "https://beta-trial.situsku.click/steal",
        "/broken-page",
      ]);

      expect(
        findCrossTenantLeaks("Welcome to Beta Trial Studio", ["beta-trial", "Beta Trial Studio"]),
      ).toEqual(["Beta Trial Studio"]);
      expect(
        findCrossTenantLeaks("Welcome to Alpha Studio", ["beta-trial", "Beta Trial Studio"]),
      ).toEqual([]);
    });
  });

  describe("3. Synthetic PLAN.md §15.2 Policy Matrix Verification", () => {
    it("enforces complete state matrix: published, empty archives, taxonomy opt-in, pagination, tracking params, noindex, 404, 308, alias, suspended", () => {
      const home = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        resourceState: "published",
      });
      expect(home.httpStatus).toBe(200);
      expect(home.indexable).toBe(true);
      expect(home.sitemapEligible).toBe(true);
      expect(home.canonical).toBe("https://www.alpha-studio.id/");

      const tracked = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/layanan/audit-gedung",
        query: "utm_source=google&fbclid=xyz&gclid=999",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        resourceState: "published",
      });
      expect(tracked.httpStatus).toBe(200);
      expect(tracked.canonical).toBe("https://www.alpha-studio.id/layanan/audit-gedung");

      const emptyBlog = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "blog_index",
        pathname: "/blog",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        archiveEnabled: true,
        publishedItemCount: 0,
      });
      expect(emptyBlog.httpStatus).toBe(200);
      expect(emptyBlog.indexable).toBe(false);
      expect(emptyBlog.sitemapEligible).toBe(false);
      expect(emptyBlog.robotsMeta).toBe("noindex, follow");

      const taxDefault = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "category_archive",
        pathname: "/blog/category/panduan",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        taxonomyIndexOptIn: false,
        taxonomyHasUsefulIntro: true,
        publishedItemCount: 3,
      });
      expect(taxDefault.httpStatus).toBe(200);
      expect(taxDefault.indexable).toBe(false);
      expect(taxDefault.sitemapEligible).toBe(false);

      const taxOptedIn = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "category_archive",
        pathname: "/blog/category/panduan",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        taxonomyIndexOptIn: true,
        taxonomyHasUsefulIntro: true,
        publishedItemCount: 3,
      });
      expect(taxOptedIn.httpStatus).toBe(200);
      expect(taxOptedIn.indexable).toBe(true);
      expect(taxOptedIn.sitemapEligible).toBe(true);
      expect(taxOptedIn.canonical).toBe("https://www.alpha-studio.id/blog/category/panduan");

      const taxEmptyOptedIn = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "category_archive",
        pathname: "/blog/category/kosong",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        taxonomyIndexOptIn: true,
        taxonomyHasUsefulIntro: true,
        publishedItemCount: 0,
      });
      expect(taxEmptyOptedIn.indexable).toBe(false);
      expect(taxEmptyOptedIn.sitemapEligible).toBe(false);

      const page2 = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "blog_index",
        pathname: "/blog",
        query: "page=2",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        archiveEnabled: true,
        publishedItemCount: 20,
        totalPages: 3,
      });
      expect(page2.httpStatus).toBe(200);
      expect(page2.canonical).toBe("https://www.alpha-studio.id/blog?page=2");
      expect(page2.sitemapEligible).toBe(false);

      const pageOutOfRange = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "blog_index",
        pathname: "/blog",
        query: "page=9",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        archiveEnabled: true,
        publishedItemCount: 20,
        totalPages: 3,
      });
      expect(pageOutOfRange.httpStatus).toBe(404);
      expect(pageOutOfRange.canonical).toBeNull();
      expect(pageOutOfRange.indexable).toBe(false);

      const perPageNoindex = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/halaman-promo-internal",
        tenant: TENANT_A_ACTIVE,
        siteVisibility: "public",
        resourceState: "published",
        resourceSeo: { noindex: true },
      });
      expect(perPageNoindex.httpStatus).toBe(200);
      expect(perPageNoindex.robotsMeta).toBe("noindex, follow");
      expect(perPageNoindex.canonical).toBe("https://www.alpha-studio.id/halaman-promo-internal");
      expect(perPageNoindex.sitemapEligible).toBe(false);

      const robotsActive = buildRobotsTxtPolicy({ tenant: TENANT_A_ACTIVE, siteVisibility: "public" });
      expect(isPathAllowedByRobotsTxt(robotsActive.body, "Googlebot", "/halaman-promo-internal")).toBe(true);
      const parsedRobots = parseRobotsTxt(robotsActive.body);
      expect(parsedRobots.disallowAllWildcard).toBe(false);
      expect(parsedRobots.sitemaps).toEqual(["https://www.alpha-studio.id/sitemap.xml"]);

      for (const state of ["draft", "trashed", "missing"] as const) {
        const res = resolvePublishedSeoDecision({
          surface: "public_tenant",
          routeKind: "page",
          pathname: "/secret",
          tenant: TENANT_A_ACTIVE,
          siteVisibility: "public",
          resourceState: state,
        });
        expect(res.httpStatus).toBe(404);
        expect(res.indexable).toBe(false);
        expect(res.canonical).toBeNull();
        expect(res.sitemapEligible).toBe(false);
      }

      const formerSlug = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "former_slug",
        pathname: "/old-about",
        redirectTargetPath: "/tentang-kami",
        tenant: TENANT_A_ACTIVE,
      });
      expect(formerSlug.httpStatus).toBe(308);
      expect(formerSlug.redirectTarget).toBe("https://www.alpha-studio.id/tentang-kami");
      expect(formerSlug.canonical).toBe("https://www.alpha-studio.id/tentang-kami");
      expect(formerSlug.canonical).not.toContain("/old-about");
      expect(formerSlug.sitemapEligible).toBe(false);

      const aliasRes = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/tentang-kami",
        tenant: TENANT_A_ALIAS,
      });
      // PLAN §3.3 #7 / TASK-002 / TASK-051: alias host emits single permanent redirect to primary origin
      expect(aliasRes.httpStatus).toBe(301);
      expect(aliasRes.redirectTarget).toBe("https://www.alpha-studio.id/tentang-kami");

      const trialHome = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: TENANT_B_TRIAL,
        siteVisibility: "public",
        resourceState: "published",
      });
      expect(trialHome.httpStatus).toBe(200);
      expect(trialHome.indexable).toBe(false);
      expect(trialHome.sitemapEligible).toBe(false);
      expect(trialHome.robotsMeta).toBe("noindex, nofollow");
      const trialRobots = buildRobotsTxtPolicy({ tenant: TENANT_B_TRIAL });
      expect(parseRobotsTxt(trialRobots.body).disallowAllWildcard).toBe(true);
      expect(parseRobotsTxt(trialRobots.body).sitemaps).toEqual([]);

      const susp = resolvePublishedSeoDecision({
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: TENANT_SUSPENDED,
      });
      expect(susp.httpStatus).toBe(503);
      expect(susp.indexable).toBe(false);
      expect(susp.canonical).toBeNull();
      expect(susp.sitemapEligible).toBe(false);
      expect(susp.cacheControl).toBe("no-store");

      expect(() =>
        resolveVerifiedCanonicalOrigin({
          ...TENANT_A_ACTIVE,
          primaryHost: "evil.attacker.example",
          verifiedTenantHosts: ["www.alpha-studio.id"],
        }),
      ).toThrow(SeoPolicyError);
    });
  });

  describe("4. Custom Theme Shared Head Policy & Static Import Hygiene", () => {
    it("verifies custom theme `sample-agency` shares the single canonical/robots/JSON-LD head contract and passes static import audit", () => {
      const repoRoot = path.resolve(import.meta.dirname, "../..");
      const customThemesDir = path.join(repoRoot, "apps/web/src/themes/custom");
      const files: Array<{ readonly filePath: string; readonly content: string }> = [];

      function collectFiles(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) collectFiles(full);
          else if (/\.(?:astro|ts|js|css)$/.test(entry.name)) {
            files.push({
              filePath: path.relative(customThemesDir, full),
              content: fs.readFileSync(full, "utf8"),
            });
          }
        }
      }
      collectFiles(customThemesDir);

      const staticAudit = auditCustomThemeSourceFiles(files);
      expect(staticAudit.ok).toBe(true);
      expect(staticAudit.violations).toEqual([]);

      const contract = buildPublicThemeRouteShellContract({
        entitlement: {
          tenantId: "t_alpha",
          tenantStatus: "active",
          requestedThemeId: SAMPLE_AGENCY_THEME_ID,
          tenantGrants: [
            { tenantId: "t_alpha", themeId: SAMPLE_AGENCY_THEME_ID, active: true, grantedBy: "op" },
          ],
        },
        routeKind: "home",
        pathname: "/",
        shell: {
          isPreview: false,
          layoutMode: "standard",
          themeId: SAMPLE_AGENCY_THEME_ID,
          baseThemeId: "compro",
          themeStyle: buildSafeThemeStyleBlock(null, "compro"),
          site: {
            title: "Alpha Studio",
            tagline: "Arsitektur B2B",
            locale: "id-ID",
            timezone: "Asia/Jakarta",
            blogEnabled: true,
            catalogEnabled: true,
            siteVisibility: "public",
            analyticsConfig: null,
          },
          business: {
            name: "Alpha Studio",
            category: "contractor",
            description: "Konsultan arsitektur B2B.",
            address: "Jl. Kemang No. 18",
            city: "Jakarta Selatan",
            province: "DKI Jakarta",
            postalCode: "12730",
            mapsUrl: null,
            weekdayHours: "Senin-Jumat 08:00-17:00 WIB",
            holidayHours: null,
            phone: "021-7190011",
            whatsappE164: "6281234567890",
            email: "halo@alpha-studio.id",
            socialLinks: [],
          },
          menus: { header: [], footer: [], mobile: [] },
          page: null,
          revisions: {
            siteSettingsVersion: 1,
            businessProfileVersion: 1,
            themeConfigVersion: 1,
            pageVersion: 1,
          },
        },
        seo: {
          surface: "public_tenant",
          routeKind: "homepage",
          pathname: "/",
          tenant: TENANT_A_ACTIVE,
          siteVisibility: "public",
          resourceState: "published",
        },
      });

      expect(contract.resolution.fallbackUsed).toBe(false);
      expect(contract.resolution.resolvedTheme.id).toBe(SAMPLE_AGENCY_THEME_ID);
      expect(contract.seoMetadata.canonical).toBe("https://www.alpha-studio.id/");
      expect(contract.schemaGraph).not.toBeNull();

      const headHtml = renderSeoHeadHtml(contract.seoMetadata, { jsonLd: contract.schemaGraph });
      const headAudit = auditHttpCrawlPage({
        url: "https://www.alpha-studio.id/",
        status: 200,
        html: `<!doctype html><html><head>${headHtml}</head><body><h1>Alpha Studio</h1></body></html>`,
        expectedOrigin: "https://www.alpha-studio.id",
      });
      expect(headAudit.titleCount).toBe(1);
      expect(headAudit.descriptionCount).toBeLessThanOrEqual(1);
      expect(headAudit.robotsMetaCount).toBe(1);
      expect(headAudit.canonicalCount).toBe(1);
      expect(headAudit.jsonLdCount).toBe(1);
      expect(headAudit.jsonLdForeignOriginUrls).toEqual([]);
      expect(headAudit.hasUnescapedHtmlInjectionInDocument).toBe(false);
    });
  });
});
