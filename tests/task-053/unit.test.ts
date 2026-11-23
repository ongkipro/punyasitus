import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateOpenGraphMetadata } from "../../packages/core/src/og-generator.ts";
import {
  generateSchemaGraph,
  type SchemaGraphDocument,
} from "../../packages/core/src/schema-generator.ts";
import {
  DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  type SearchAppearanceSettings,
} from "../../packages/core/src/seo/editor.ts";
import {
  INDEXABLE_ROBOTS_DIRECTIVES,
  type VerifiedTenantHostInput,
} from "../../packages/core/src/seo/index.ts";
import {
  auditRenderedPublicPageSeo,
  composePublicSeoHead,
  extractJsonLdBlocksFromHtml,
  formatAuthorSameAsLabel,
  injectTocHeadingAnchors,
  MAX_AUTHOR_BIO_LENGTH,
  MAX_AUTHOR_SAME_AS_LINKS,
  normalizeAuthorBio,
  normalizeAuthorSameAsUrls,
  sanitizeHtmlInternalLinks,
  sanitizeTenantLocalHref,
} from "../../packages/core/src/seo/local-entity.ts";
import {
  FAIL_CLOSED_PUBLIC_SEO_CONTEXT,
  loadPublicSeoCtxSafe,
} from "../../apps/web/src/components/seo/public-seo-context.ts";

const TENANT_ALPHA: VerifiedTenantHostInput = {
  tenantHandle: "nusantara-arsitek",
  tenantStatus: "active",
  operatorHold: false,
  primaryHost: "www.nusantara-arsitek.id",
  primaryHostKind: "custom",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.nusantara-arsitek.id", "nusantara-arsitek.situsku.click"],
  servingHost: "www.nusantara-arsitek.id",
};

const TENANT_TRIAL: VerifiedTenantHostInput = {
  tenantHandle: "trial-demo",
  tenantStatus: "trial",
  operatorHold: false,
  primaryHost: "trial-demo.situsku.click",
  primaryHostKind: "subdomain",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["trial-demo.situsku.click"],
  servingHost: "trial-demo.situsku.click",
};

function findNodeByType(graph: SchemaGraphDocument | null, type: string) {
  return graph?.["@graph"].find((n) => n["@type"] === type) ?? null;
}

describe("TASK-053 unit — Single <head> Authority, Verification Meta, RSS & Autopilot Toggle", () => {
  it("emits exactly ONE title, ONE robots meta, ONE canonical, ONE JSON-LD graph, verification tags, and RSS alternate when blogEnabled", () => {
    const seo = {
      surface: "public_tenant" as const,
      routeKind: "homepage" as const,
      pathname: "/",
      tenant: TENANT_ALPHA,
      siteVisibility: "public" as const,
      resourceState: "published" as const,
    };
    const metadata = generateOpenGraphMetadata({
      seo,
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      siteTagline: "Konsultan Renovasi B2B",
      locale: "id-ID",
      resourceTitle: "Beranda",
      resourceExcerpt: "Jasa desain dan renovasi kantor modern di Jakarta.",
    });
    const schema = generateSchemaGraph({
      seo,
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      siteTagline: "Konsultan Renovasi B2B",
      business: {
        businessName: "PT Nusantara Arsitek",
        legalName: "PT Nusantara Arsitek Indonesia",
        businessCategory: "contractor",
        address: "Jl. Kemang Raya No. 18",
        city: "Jakarta Selatan",
        phone: "021-7190011",
        whatsappE164: "6281234567890",
        weekdayHours: "Senin-Jumat 08:00-17:00 WIB",
        mapsUrl: "https://maps.google.com/?q=-6.2607,106.8132",
      },
    });

    const customTemplates: SearchAppearanceSettings = {
      ...DEFAULT_SEARCH_APPEARANCE_SETTINGS,
      separator: "|",
      templates: {
        ...DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates,
        homepage: {
          titleTemplate: "{{site_name}} {{sep}} {{tagline}}",
          descriptionTemplate: "{{excerpt}}",
        },
      },
    };

    const composed = composePublicSeoHead({
      metadata,
      schemaGraph: schema.graph,
      seoAutopilotEnabled: true,
      publishedVerificationTokens: {
        google: "gscAlphaToken_2026_Valid",
        bing: "0123456789ABCDEF2026",
        yandex: null,
      },
      blogEnabled: true,
      siteName: "PT Nusantara Arsitek",
      searchAppearance: customTemplates,
      templateValues: {
        routeKind: "homepage",
        title: "Beranda",
        tagline: "Konsultan Renovasi B2B",
        excerpt: "Jasa desain dan renovasi kantor modern di Jakarta.",
      },
    });

    const fullDoc = `<!doctype html><html><head>${composed.html}</head><body><h1>PT Nusantara Arsitek</h1><a href="/layanan">Layanan</a></body></html>`;
    const audit = auditRenderedPublicPageSeo(fullDoc, {
      verifiedOrigin: "https://www.nusantara-arsitek.id",
    });

    expect(audit.titleCount).toBe(1);
    expect(audit.robotsMetaCount).toBe(1);
    expect(audit.robotsContents[0]).toBe(INDEXABLE_ROBOTS_DIRECTIVES);
    expect(audit.canonicalCount).toBe(1);
    expect(audit.canonicalHref).toBe("https://www.nusantara-arsitek.id/");
    expect(audit.jsonLdCount).toBe(1);
    expect(audit.rssAlternateHref).toBe("https://www.nusantara-arsitek.id/blog/feed.xml");
    expect(composed.verificationMetaTags).toEqual([
      '<meta name="google-site-verification" content="gscAlphaToken_2026_Valid" />',
      '<meta name="msvalidate.01" content="0123456789ABCDEF2026" />',
    ]);
    expect(composed.effectiveTitle).toBe("PT Nusantara Arsitek | Konsultan Renovasi B2B");
    expect(audit.hasDeprecatedProfessionalService).toBe(false);
    expect(audit.hasFabricatedRatingOrReview).toBe(false);
    expect(audit.hasMerchantListingProps).toBe(false);
  });

  it("omits RSS link when blogEnabled is false and drops autopilot clutter while preserving trial noindex when seoAutopilotEnabled is false", () => {
    const trialSeo = {
      surface: "public_tenant" as const,
      routeKind: "homepage" as const,
      pathname: "/",
      tenant: TENANT_TRIAL,
      siteVisibility: "public" as const,
      resourceState: "published" as const,
    };
    const trialMeta = generateOpenGraphMetadata({
      seo: trialSeo,
      tenantId: "t_trial",
      siteName: "Trial Demo",
    });
    const trialSchema = generateSchemaGraph({
      seo: trialSeo,
      tenantId: "t_trial",
      siteName: "Trial Demo",
    });

    const disabledPluginHead = composePublicSeoHead({
      metadata: trialMeta,
      schemaGraph: trialSchema.graph,
      seoAutopilotEnabled: false,
      publishedVerificationTokens: { google: "gscAlphaToken_2026_Valid", bing: null, yandex: null },
      blogEnabled: false,
      siteName: "Trial Demo",
    });

    expect(disabledPluginHead.schemaEmitted).toBe(false);
    expect(disabledPluginHead.rssFeedUrl).toBeNull();
    expect(disabledPluginHead.verificationMetaTags).toEqual([]);
    expect(disabledPluginHead.html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(disabledPluginHead.html).not.toContain("google-site-verification");
    expect(disabledPluginHead.html).not.toContain("application/ld+json");
    expect(disabledPluginHead.html).not.toContain("application/rss+xml");
  });
});

describe("TASK-053 unit — Honest Schema.org @graph & resolvePublishSafeSchemaType Gating", () => {
  it("downgrades stored FAQPage to WebPage when visible FAQ items are absent, and emits FAQPage when visible items exist", () => {
    const baseSeo = {
      surface: "public_tenant" as const,
      routeKind: "page" as const,
      pathname: "/faq",
      tenant: TENANT_ALPHA,
      siteVisibility: "public" as const,
      resourceState: "published" as const,
      resourceSeo: { schemaType: "FAQPage" as const },
    };

    const withoutFaq = generateSchemaGraph({
      seo: baseSeo,
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      pageTitle: "Tanya Jawab",
      faqItems: [],
    });
    expect(findNodeByType(withoutFaq.graph, "FAQPage")).toBeNull();
    expect(findNodeByType(withoutFaq.graph, "WebPage")).not.toBeNull();

    const withFaq = generateSchemaGraph({
      seo: baseSeo,
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      pageTitle: "Tanya Jawab",
      faqItems: [
        {
          question: "Berapa lama survei lokasi?",
          answer: "Survei lokasi dijadwalkan dalam 2 hari kerja.",
        },
      ],
    });
    expect(findNodeByType(withFaq.graph, "FAQPage")).not.toBeNull();
  });

  it("gates explicit Product & TouristTrip schemaType overrides via resolvePublishSafeSchemaType", () => {
    // Product with on_request price + stored schemaType="Product" MUST downgrade to Service (no fabricated Offer)
    const downgradedProduct = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/meja-custom",
        tenant: TENANT_ALPHA,
        siteVisibility: "public",
        resourceState: "published",
        resourceSeo: { schemaType: "Product" },
      },
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      offering: {
        offeringType: "product",
        title: "Meja Rapat Custom",
        priceMode: "on_request",
        ctaMode: "whatsapp",
      },
    });
    expect(findNodeByType(downgradedProduct.graph, "Product")).toBeNull();
    const downgradedService = findNodeByType(downgradedProduct.graph, "Service");
    expect(downgradedService).not.toBeNull();
    expect(downgradedService?.offers).toBeUndefined();

    // Product with fixed price + stored schemaType="Product" emits honest Product + Offer (zero merchant checkout/shipping)
    const validProduct = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/kursi-ergonomis",
        tenant: TENANT_ALPHA,
        siteVisibility: "public",
        resourceState: "published",
        resourceSeo: { schemaType: "Product" },
      },
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      offering: {
        offeringType: "product",
        title: "Kursi Kantor Ergonomis",
        priceMode: "fixed",
        price: 2_450_000,
        ctaMode: "whatsapp",
      },
    });
    const prodNode = findNodeByType(validProduct.graph, "Product");
    expect(prodNode).not.toBeNull();
    expect(prodNode?.offers).toMatchObject({
      "@type": "Offer",
      priceCurrency: "IDR",
      price: 2_450_000,
    });
    expect(validProduct.jsonLd).not.toContain("shippingDetails");
    expect(validProduct.jsonLd).not.toContain("hasMerchantReturnPolicy");

    // Tour with stored schemaType="TouristTrip" but NO itinerary or destination MUST downgrade to Service
    const downgradedTour = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/tour/paket-kustom",
        tenant: TENANT_ALPHA,
        siteVisibility: "public",
        resourceState: "published",
        resourceSeo: { schemaType: "TouristTrip" },
      },
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      offering: {
        offeringType: "tour",
        title: "Paket Wisata Kustom",
        priceMode: "on_request",
        attributes: {},
      },
    });
    expect(findNodeByType(downgradedTour.graph, "TouristTrip")).toBeNull();
    expect(findNodeByType(downgradedTour.graph, "Service")).not.toBeNull();
  });

  it("emits rich Author Person schema (bio <= 300, verified tenant avatar, <= 5 HTTPS sameAs) and rejects cross-tenant avatar", () => {
    const longBio = "A".repeat(380);
    const res = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "post",
        pathname: "/blog/audit-gedung",
        tenant: TENANT_ALPHA,
        siteVisibility: "public",
        resourceState: "published",
      },
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      article: {
        schemaType: "BlogPosting",
        headline: "Audit Gedung </script><script>alert(1)</script>",
        datePublished: "2026-10-01T08:00:00.000Z",
        authorName: "Rina Kartika",
        authorBio: longBio,
        authorAvatar: {
          url: "https://media.punyasitus.com/t/t_alpha/media/rina.webp",
          width: 256,
          height: 256,
          alt: "Rina Kartika",
          tenantId: "t_alpha",
          status: "ready",
        },
        authorSameAs: [
          "https://www.linkedin.com/in/rina-kartika",
          "https://instagram.com/rinakartika",
          "https://x.com/rinakartika",
          "https://github.com/rinakartika",
          "https://medium.com/@rinakartika",
          "https://youtube.com/@sixth-should-be-dropped",
          "http://insecure.example.com/rina",
          "javascript:alert(1)",
        ],
      },
    });

    // Safe escaping prevents script-tag breakout
    expect(res.jsonLd).not.toContain("</script>");
    expect(res.jsonLd).toContain("\\u003c/script\\u003e");

    const article = findNodeByType(res.graph, "BlogPosting");
    const author = article?.author as Record<string, unknown>;
    expect(author["@type"]).toBe("Person");
    expect(author.name).toBe("Rina Kartika");
    expect(typeof author.description).toBe("string");
    expect((author.description as string).length).toBeLessThanOrEqual(MAX_AUTHOR_BIO_LENGTH);
    expect(author.image).toMatchObject({
      "@type": "ImageObject",
      url: "https://media.punyasitus.com/t/t_alpha/media/rina.webp",
    });
    expect(author.sameAs).toHaveLength(MAX_AUTHOR_SAME_AS_LINKS);

    // Cross-tenant avatar MUST be omitted
    const foreignAvatarRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "post",
        pathname: "/blog/audit-gedung",
        tenant: TENANT_ALPHA,
        siteVisibility: "public",
        resourceState: "published",
      },
      tenantId: "t_alpha",
      siteName: "PT Nusantara Arsitek",
      article: {
        headline: "Audit Gedung",
        authorName: "Rina Kartika",
        authorAvatar: {
          url: "https://media.punyasitus.com/t/t_beta_foreign/media/stolen.webp",
          tenantId: "t_beta_foreign",
          status: "ready",
        },
      },
    });
    const foreignAuthor = findNodeByType(foreignAvatarRes.graph, "BlogPosting")?.author as Record<
      string,
      unknown
    >;
    expect(foreignAuthor.image).toBeUndefined();
  });

  it("emits branch telephone strictly from visible phone (never WhatsApp-only) and omits fake addresses for service-area businesses", () => {
    const sabRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: TENANT_ALPHA,
        siteVisibility: "public",
        resourceState: "published",
      },
      tenantId: "t_alpha",
      siteName: "Jasa Panggilan Nusantara",
      business: {
        businessName: "Jasa Panggilan Nusantara",
        businessCategory: "ProfessionalService", // deprecated -> LocalBusiness
        serviceAreas: ["Jakarta Selatan", "Depok", "Tangerang Selatan"],
        whatsappE164: "6281234567890",
        branches: [
          {
            id: 1,
            name: "Cabang BSD",
            address: "Ruko Golden Boulevard Blok C1",
            city: "Tangerang Selatan",
            phone: null, // NO visible landline phone
            whatsappE164: "6281199887766", // WhatsApp only -> MUST NOT become Schema telephone!
            weekdayHours: "Senin-Sabtu 09:00-18:00 WIB",
          },
          {
            id: 2,
            name: "Cabang Bandung",
            address: "Jl. Braga No. 55",
            city: "Bandung",
            phone: "022-4201122",
            weekdayHours: "Senin-Jumat 08:30-17:00 WIB",
          },
        ],
      },
    });

    expect(sabRes.jsonLd).not.toContain("ProfessionalService");
    const org = sabRes.graph?.["@graph"].find(
      (n) => n["@id"] === "https://www.nusantara-arsitek.id/#organization",
    );
    expect(org?.["@type"]).toBe("LocalBusiness");
    expect(org?.address).toBeUndefined();
    expect(org?.geo).toBeUndefined();
    expect(org?.areaServed).toEqual(["Jakarta Selatan", "Depok", "Tangerang Selatan"]);

    const b1 = sabRes.graph?.["@graph"].find(
      (n) => n["@id"] === "https://www.nusantara-arsitek.id/#branch-1",
    );
    const b2 = sabRes.graph?.["@graph"].find(
      (n) => n["@id"] === "https://www.nusantara-arsitek.id/#branch-2",
    );
    expect(b1?.telephone).toBeUndefined();
    expect(b2?.telephone).toBe("+62224201122");
  });
});

describe("TASK-053 unit — Server-Rendered TOC Anchors, Author Helpers & Tenant-Local Links", () => {
  it("injects deterministic unique heading IDs on H2/H3 matching TOC entries 1:1 without JS", () => {
    const rawHtml = [
      "<p>Pembuka artikel.</p>",
      "<h2>Persiapan Awal</h2>",
      "<p>Detail persiapan.</p>",
      "<h3>Dokumen Perizinan</h3>",
      "<h2>Persiapan Awal</h2>",
      '<h3 class="sub">Estimasi Biaya &amp; Jadwal</h3>',
    ].join("\n");

    const { html, toc } = injectTocHeadingAnchors(rawHtml);
    expect(toc).toEqual([
      { id: "persiapan-awal", text: "Persiapan Awal", level: 2 },
      { id: "dokumen-perizinan", text: "Dokumen Perizinan", level: 3 },
      { id: "persiapan-awal-2", text: "Persiapan Awal", level: 2 },
      { id: "estimasi-biaya-jadwal", text: "Estimasi Biaya & Jadwal", level: 3 },
    ]);
    for (const entry of toc) {
      expect(html).toContain(`id="${entry.id}"`);
    }
  });

  it("normalizes author bio & up to 5 public HTTPS sameAs URLs cleanly", () => {
    expect(normalizeAuthorBio("  Praktisi <b>arsitektur</b>  ")?.length).toBeGreaterThan(0);
    expect(normalizeAuthorBio("x".repeat(450))?.length).toBe(MAX_AUTHOR_BIO_LENGTH);

    const parsed = normalizeAuthorSameAsUrls(
      JSON.stringify([
        "https://linkedin.com/in/budi",
        "https://instagram.com/budi",
        "http://bad.example.com",
        "https://localhost/evil",
        "javascript:alert(1)",
        "https://github.com/budi",
        "https://x.com/budi",
        "https://youtube.com/@budi",
        "https://tiktok.com/@sixth",
      ]),
    );
    expect(parsed).toHaveLength(5);
    expect(formatAuthorSameAsLabel("https://www.linkedin.com/in/budi")).toBe("LinkedIn");
    expect(formatAuthorSameAsLabel("https://example.co.id/profil")).toBe("example.co.id");
  });

  it("sanitizes tenant-local links: strips tracking params, blocks admin/preview/numeric-ID/cross-tenant/unsafe links", () => {
    const publishedPaths = new Set(["/", "/layanan", "/blog", "/blog/panduan-audit", "/tentang"]);

    const cleanTracking = sanitizeTenantLocalHref("/blog/panduan-audit?utm_source=ig&fbclid=abc#ringkasan", {
      verifiedOrigin: "https://www.nusantara-arsitek.id",
      publishedPaths,
    });
    expect(cleanTracking).toEqual({
      ok: true,
      href: "/blog/panduan-audit#ringkasan",
      reason: null,
    });

    const pageOneCleaned = sanitizeTenantLocalHref("/blog?page=1&gclid=xyz", {
      verifiedOrigin: "https://www.nusantara-arsitek.id",
      publishedPaths,
    });
    expect(pageOneCleaned).toEqual({ ok: true, href: "/blog", reason: null });

    expect(sanitizeTenantLocalHref("/dashboard/alpha/pages").ok).toBe(false);
    expect(sanitizeTenantLocalHref("/preview/pages/1").ok).toBe(false);
    expect(sanitizeTenantLocalHref("/api/leads").ok).toBe(false);
    expect(sanitizeTenantLocalHref("/blog/42").ok).toBe(false);
    expect(sanitizeTenantLocalHref("javascript:alert(1)").ok).toBe(false);
    expect(sanitizeTenantLocalHref("//evil.example.com/phish").ok).toBe(false);
    expect(
      sanitizeTenantLocalHref("/blog/draft-rahasia", { publishedPaths }),
    ).toMatchObject({ ok: false, reason: "unpublished_or_foreign_target" });

    // Valid tel:, mailto:, and external HTTPS links pass
    expect(sanitizeTenantLocalHref("tel:+62217190011").ok).toBe(true);
    expect(sanitizeTenantLocalHref("mailto:halo@nusantara-arsitek.id").ok).toBe(true);
    expect(sanitizeTenantLocalHref("https://wa.me/6281234567890").ok).toBe(true);

    // Cross-tenant SaaS subdomain & platform control-plane hosts are blocked; requireLocal blocks foreign hosts
    expect(
      sanitizeTenantLocalHref("https://other-tenant.situsku.click/blog/rahasia", {
        verifiedOrigin: "https://www.nusantara-arsitek.id",
      }),
    ).toMatchObject({ ok: false, reason: "cross_tenant_or_platform_host" });
    expect(
      sanitizeTenantLocalHref("https://app.punyasitus.com/dashboard/alpha", {
        verifiedOrigin: "https://www.nusantara-arsitek.id",
      }),
    ).toMatchObject({ ok: false, reason: "cross_tenant_or_platform_host" });
    expect(
      sanitizeTenantLocalHref("https://example.org/ext", {
        verifiedOrigin: "https://www.nusantara-arsitek.id",
        requireLocal: true,
      }),
    ).toMatchObject({ ok: false, reason: "foreign_host" });

    // sanitizeHtmlInternalLinks unwraps broken/draft/forbidden/cross-tenant links while cleaning valid ones
    const rawBody = [
      '<p>Baca <a href="/blog/panduan-audit?utm_source=ig&amp;fbclid=123#ringkasan">panduan resmi</a></p>',
      '<p>Cek <a href="/blog/draft-rahasia">artikel draf</a> dan <a href="/dashboard/alpha">admin</a></p>',
      '<p>Lihat <a href="https://other-tenant.situsku.click/produk/x">tenant lain</a> dan <a href="https://wa.me/6281234567890">WA resmi</a></p>',
    ].join("\n");
    const cleanedBody = sanitizeHtmlInternalLinks(rawBody, {
      verifiedOrigin: "https://www.nusantara-arsitek.id",
      publishedPaths,
    });
    expect(cleanedBody).toContain('href="/blog/panduan-audit#ringkasan"');
    expect(cleanedBody).not.toContain("utm_source");
    expect(cleanedBody).not.toContain("fbclid");
    expect(cleanedBody).not.toContain('href="/blog/draft-rahasia"');
    expect(cleanedBody).toContain("artikel draf");
    expect(cleanedBody).not.toContain('href="/dashboard/alpha"');
    expect(cleanedBody).not.toContain("other-tenant.situsku.click");
    expect(cleanedBody).toContain("tenant lain");
    expect(cleanedBody).toContain('href="https://wa.me/6281234567890"');
  });

  it("fails closed (seoAutopilotEnabled: false) when loadPublicSeoCtxSafe encounters a DB error or missing tenantDb", async () => {
    const missingDbCtx = await loadPublicSeoCtxSafe({}, "t_missing");
    expect(missingDbCtx).toEqual(FAIL_CLOSED_PUBLIC_SEO_CONTEXT);
    expect(missingDbCtx.seoAutopilotEnabled).toBe(false);

    const throwingDb = {
      prepare() {
        throw new Error("D1_ERROR: database temporarily unavailable");
      },
    } as unknown as D1Database;
    const errorCtx = await loadPublicSeoCtxSafe({ tenantDb: throwingDb }, "t_err");
    expect(errorCtx).toEqual(FAIL_CLOSED_PUBLIC_SEO_CONTEXT);
    expect(errorCtx.seoAutopilotEnabled).toBe(false);
    expect(errorCtx.publishedSettings).toBeNull();
  });

  it("extracts and parses JSON-LD blocks safely", () => {
    const blocks = extractJsonLdBlocksFromHtml(
      `<head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[]}</script></head>`,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.parseError).toBeNull();
    expect(blocks[0]?.parsed?.["@context"]).toBe("https://schema.org");
  });
});

describe("TASK-053 unit — Public Theme & Head Boundary Enforcement", () => {
  it("wires apps/web/src/pages/index.astro tenant homepage through enrichPublicPageRouteResult, PublicSeoHead, managedHead={true}, and SectionBranches", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const indexSrc = fs.readFileSync(path.join(root, "apps/web/src/pages/index.astro"), "utf8");
    expect(indexSrc).toContain("enrichPublicPageRouteResult");
    expect(indexSrc).toContain("PublicSeoHead");
    expect(indexSrc).toContain("managedHead={true}");
    expect(indexSrc).toContain("SectionBranches");
    expect(indexSrc).toContain("resolvePublicPageRoute");
    expect(indexSrc).toContain("__Host-ps_consent=");
    expect(indexSrc).not.toContain('import SEOHead from "../components/SEOHead.astro"');
    expect(indexSrc).not.toContain("<SEOHead");
  });
  it("keeps PublicSeoHead.astro, Layout.astro, and sections strictly isolated from React/Radix/BaseUI/DB/Sparkles", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const filesToCheck = [
      path.join(root, "apps/web/src/components/seo/PublicSeoHead.astro"),
      path.join(root, "apps/web/src/themes/default/Layout.astro"),
      path.join(root, "apps/web/src/themes/default/sections/SectionRenderer.astro"),
      path.join(root, "apps/web/src/themes/default/sections/SectionBranches.astro"),
    ];

    const forbidden = [
      /@radix-ui\//,
      /@base-ui\/react/,
      /from\s+["']react["']/,
      /@punyasitus\/db/,
      /@punyasitus\/auth/,
      /client:(?:load|idle|visible|only|media)/,
      /components\/ui/,
      /\bSparkles(?:Icon)?\b/,
    ];

    for (const file of filesToCheck) {
      const src = fs.readFileSync(file, "utf8");
      for (const re of forbidden) {
        expect(src, `${path.basename(file)} matched forbidden pattern ${re}`).not.toMatch(re);
      }
    }
  });
});
