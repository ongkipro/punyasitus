import {
  ALLOWED_BUSINESS_SCHEMA_TYPES,
  FAQ_RICH_RESULT_NOTE,
  SCHEMA_ORG_CONTEXT,
  SCHEMA_RICH_RESULT_DISCLAIMER,
  filterUpcomingDepartureDates,
  generatePublishedResourceSchema,
  generateSchemaGraph,
  renderSchemaScriptTag,
  resolveBusinessSchemaType,
  serializeSchemaGraph,
  type SchemaGraphDocument,
  type SchemaNode,
} from "@punyasitus/core/schema-generator";
import type {
  BusinessProfileSnapshot,
  OfferingSnapshot,
  PageSnapshot,
  PostSnapshot,
  PublishedResourceDto,
  SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import { renderSeoHeadHtml, generateOpenGraphMetadata } from "@punyasitus/core/og-generator";
import { SeoPolicyError, type VerifiedTenantHostInput } from "@punyasitus/core/seo/index";
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

const SUBDOMAIN_TENANT: VerifiedTenantHostInput = {
  tenantHandle: "alpha-studio",
  tenantStatus: "active",
  primaryHost: "alpha-studio.situsku.click",
  primaryHostKind: "subdomain",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
};

function parseAndValidateGraph(jsonLd: string | null): SchemaGraphDocument {
  expect(jsonLd).not.toBeNull();
  const parsed = JSON.parse(jsonLd!) as SchemaGraphDocument;
  expect(parsed["@context"]).toBe(SCHEMA_ORG_CONTEXT);
  expect(Array.isArray(parsed["@graph"])).toBe(true);
  expect(parsed["@graph"].length).toBeGreaterThan(0);
  return parsed;
}

function findNodeByType(graph: SchemaGraphDocument, schemaType: string): SchemaNode | undefined {
  return graph["@graph"].find((node) => node["@type"] === schemaType);
}

describe("TASK-015: Verified Canonical Origins & Suppression Gates", () => {
  it("emits parseable Schema.org @graph with verified canonical URLs and updates @ids when primary origin changes", () => {
    const onSubdomain = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: SUBDOMAIN_TENANT,
      },
      siteName: "Alpha Studio",
      siteTagline: "Jasa Desain Interior Surabaya",
      business: {
        businessName: "PT Alpha Studio",
        businessCategory: "LocalBusiness",
      },
    });

    expect(onSubdomain.emitted).toBe(true);
    expect(onSubdomain.verifiedOrigin).toBe("https://alpha-studio.situsku.click");
    const subGraph = parseAndValidateGraph(onSubdomain.jsonLd);
    expect(findNodeByType(subGraph, "WebSite")?.["@id"]).toBe(
      "https://alpha-studio.situsku.click/#website",
    );
    expect(findNodeByType(subGraph, "LocalBusiness")?.["@id"]).toBe(
      "https://alpha-studio.situsku.click/#organization",
    );

    const onCustom = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Alpha Studio",
      siteTagline: "Jasa Desain Interior Surabaya",
      business: {
        businessName: "PT Alpha Studio",
        businessCategory: "LocalBusiness",
      },
    });

    expect(onCustom.emitted).toBe(true);
    expect(onCustom.verifiedOrigin).toBe("https://www.alphastudio.id");
    const customGraph = parseAndValidateGraph(onCustom.jsonLd);
    const webSite = findNodeByType(customGraph, "WebSite");
    const localBiz = findNodeByType(customGraph, "LocalBusiness");
    const webPage = findNodeByType(customGraph, "WebPage");

    expect(webSite?.["@id"]).toBe("https://www.alphastudio.id/#website");
    expect(webSite?.url).toBe("https://www.alphastudio.id/");
    expect(webSite?.publisher).toEqual({ "@id": "https://www.alphastudio.id/#organization" });
    expect(localBiz?.["@id"]).toBe("https://www.alphastudio.id/#organization");
    expect(webPage?.["@id"]).toBe("https://www.alphastudio.id/#webpage");
    expect(webPage?.url).toBe("https://www.alphastudio.id/");
    expect(webPage?.isPartOf).toEqual({ "@id": "https://www.alphastudio.id/#website" });
    expect(webPage?.about).toEqual({ "@id": "https://www.alphastudio.id/#organization" });
  });

  it("never trusts malicious/foreign host values and fails closed with SeoPolicyError", () => {
    const hostileHosts = [
      "javascript:alert(1)",
      "http://evil.example",
      "127.0.0.1",
      "other-tenant.situsku.click",
      "evil.example/path",
      "evil.example:8443",
      "user:pass@evil.example",
      "evil.example\r\nX-Injected: 1",
    ];

    for (const primaryHost of hostileHosts) {
      expect(() =>
        generateSchemaGraph({
          seo: {
            surface: "public_tenant",
            routeKind: "homepage",
            pathname: "/",
            tenant: {
              ...ACTIVE_CUSTOM_TENANT,
              primaryHost,
            },
          },
          siteName: "Alpha Studio",
        }),
      ).toThrow(SeoPolicyError);
    }
  });

  it("suppresses JSON-LD completely for draft, preview, private, error, suspended, recovery, purged, and unknown-host routes", () => {
    const suppressedCases: Array<{
      readonly label: string;
      readonly input: Parameters<typeof generateSchemaGraph>[0];
    }> = [
      {
        label: "draft page",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "page",
            pathname: "/rahasia",
            tenant: ACTIVE_CUSTOM_TENANT,
            resourceState: "draft",
          },
          siteName: "Alpha Studio",
          pageTitle: "Draft Internal",
        },
      },
      {
        label: "unpublished offering",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "offering",
            pathname: "/produk/belum-rilis",
            tenant: ACTIVE_CUSTOM_TENANT,
            resourceState: "unpublished",
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "trashed post",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "post",
            pathname: "/blog/terhapus",
            tenant: ACTIVE_CUSTOM_TENANT,
            resourceState: "trashed",
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "admin preview route",
        input: {
          seo: {
            surface: "preview",
            routeKind: "preview",
            pathname: "/dashboard/alpha-studio/preview/page/1",
            tenant: ACTIVE_CUSTOM_TENANT,
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "private admin route",
        input: {
          seo: {
            surface: "app",
            routeKind: "admin",
            pathname: "/dashboard/alpha-studio/pages",
            tenant: ACTIVE_CUSTOM_TENANT,
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "404 error route",
        input: {
          seo: {
            surface: "error",
            routeKind: "error_404",
            pathname: "/tidak-ada",
            tenant: ACTIVE_CUSTOM_TENANT,
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "503 error route",
        input: {
          seo: {
            surface: "error",
            routeKind: "error_503",
            pathname: "/",
            tenant: ACTIVE_CUSTOM_TENANT,
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "unknown host",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "unknown_host",
            pathname: "/",
            tenant: null,
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "suspended tenant",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "homepage",
            pathname: "/",
            tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "suspended" },
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "operatorHold tenant",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "homepage",
            pathname: "/",
            tenant: { ...ACTIVE_CUSTOM_TENANT, operatorHold: true },
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "recovery tenant",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "homepage",
            pathname: "/",
            tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "recovery" },
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "destroyed tenant",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "homepage",
            pathname: "/",
            tenant: { ...ACTIVE_CUSTOM_TENANT, tenantStatus: "destroyed" },
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "former slug 308 redirect",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "former_slug",
            pathname: "/old-slug",
            redirectTargetPath: "/new-slug",
            tenant: ACTIVE_CUSTOM_TENANT,
          },
          siteName: "Alpha Studio",
        },
      },
      {
        label: "search/filter altered route without canonical",
        input: {
          seo: {
            surface: "public_tenant",
            routeKind: "search_or_filter",
            pathname: "/produk",
            query: "q=kopi",
            tenant: ACTIVE_CUSTOM_TENANT,
          },
          siteName: "Alpha Studio",
        },
      },
    ];

    for (const testCase of suppressedCases) {
      const res = generateSchemaGraph(testCase.input);
      expect(res.emitted, testCase.label).toBe(false);
      expect(res.graph, testCase.label).toBeNull();
      expect(res.nodes, testCase.label).toEqual([]);
      expect(res.jsonLd, testCase.label).toBeNull();
      expect(res.scriptTag, testCase.label).toBeNull();
      expect(res.suppressionReason, testCase.label).not.toBeNull();
    }

    expect(renderSchemaScriptTag(null)).toBeNull();
  });
});

describe("TASK-015: WebSite, Organization / LocalBusiness, Branches & Visible Facts Only", () => {
  it("emits only populated visible business facts and omits unprovided address/geo/phone/sameAs", () => {
    // Service-area business with NO physical address — must NEVER invent an address or geo!
    const serviceAreaRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Konsultan Mandiri",
      business: {
        businessName: "Konsultan Mandiri",
        businessCategory: "ProfessionalService", // deprecated -> MUST map to LocalBusiness
        serviceAreas: ["Jakarta Selatan", "Tangerang"],
      },
    });

    const graph = parseAndValidateGraph(serviceAreaRes.jsonLd);
    expect(serviceAreaRes.jsonLd).not.toContain("ProfessionalService");
    const org = findNodeByType(graph, "LocalBusiness");
    expect(org).toBeDefined();
    expect(org?.name).toBe("Konsultan Mandiri");
    expect(org?.areaServed).toEqual(["Jakarta Selatan", "Tangerang"]);
    expect(org?.address).toBeUndefined();
    expect(org?.geo).toBeUndefined();
    expect(org?.telephone).toBeUndefined();
    expect(org?.email).toBeUndefined();
    expect(org?.sameAs).toBeUndefined();
    expect(org?.aggregateRating).toBeUndefined();
    expect(org?.review).toBeUndefined();
  });

  it("emits complete LocalBusiness/TravelAgency details, validated sameAs links, ready logo, and branches", () => {
    const res = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      tenantId: "01JTESTTENANTALPHA00000001",
      siteName: "Nusantara Travel",
      siteTagline: "Paket Wisata Resmi",
      business: {
        businessName: "PT Nusantara Wisata",
        businessCategory: "TravelAgency",
        description: "Biro perjalanan wisata Nusantara berizin resmi.",
        logo: {
          url: "https://media.punyasitus.com/t/01JTESTTENANTALPHA00000001/media/logo.webp",
          width: 400,
          height: 120,
          alt: "Logo Nusantara Travel",
          tenantId: "01JTESTTENANTALPHA00000001",
          status: "ready",
        },
        phone: "0812-3456-7890",
        publicEmail: "halo@alphastudio.id",
        address: "Jl. Sudirman No. 10",
        city: "Jakarta Pusat",
        province: "DKI Jakarta",
        postalCode: "10220",
        latitude: -6.2088,
        longitude: 106.8456,
        mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
        weekdayHours: "Senin–Jumat 09:00–17:00",
        holidayHours: "Sabtu 09:00–14:00",
        socialLinks: [
          { platform: "instagram", url: "https://instagram.com/nusantaratravel" },
          { platform: "youtube", url: "https://youtube.com/@nusantaratravel" },
          { platform: "website", url: "javascript:alert(1)" },
          { platform: "website", url: "http://insecure.example/foo" },
          { platform: "website", url: "https://localhost/admin" },
        ],
        branches: [
          {
            name: "Cabang Surabaya",
            address: "Jl. Basuki Rahmat No. 5",
            city: "Surabaya",
            province: "Jawa Timur",
            phone: "62811999888",
            latitude: -7.2654,
            longitude: 112.7425,
          },
        ],
      },
    });

    const graph = parseAndValidateGraph(res.jsonLd);
    const agency = findNodeByType(graph, "TravelAgency");
    expect(agency).toBeDefined();
    expect(agency?.telephone).toBe("+6281234567890");
    expect(agency?.email).toBe("halo@alphastudio.id");
    expect(agency?.address).toEqual({
      "@type": "PostalAddress",
      streetAddress: "Jl. Sudirman No. 10",
      addressLocality: "Jakarta Pusat",
      addressRegion: "DKI Jakarta",
      postalCode: "10220",
      addressCountry: "ID",
    });
    expect(agency?.geo).toEqual({
      "@type": "GeoCoordinates",
      latitude: -6.2088,
      longitude: 106.8456,
    });
    expect(agency?.logo).toEqual({
      "@type": "ImageObject",
      url: "https://media.punyasitus.com/t/01JTESTTENANTALPHA00000001/media/logo.webp",
      width: 400,
      height: 120,
      caption: "Logo Nusantara Travel",
    });
    expect(agency?.sameAs).toEqual([
      "https://instagram.com/nusantaratravel",
      "https://youtube.com/@nusantaratravel",
    ]);
    expect(agency?.openingHours).toEqual(["Senin–Jumat 09:00–17:00", "Sabtu 09:00–14:00"]);
    expect(agency?.subOrganization).toEqual([{ "@id": "https://www.alphastudio.id/#branch-1" }]);

    const branch = graph["@graph"].find(
      (n) => n["@id"] === "https://www.alphastudio.id/#branch-1",
    );
    expect(branch?.["@type"]).toBe("TravelAgency");
    expect(branch?.name).toBe("Cabang Surabaya");
    expect(branch?.telephone).toBe("+62811999888");
    expect(branch?.parentOrganization).toEqual({
      "@id": "https://www.alphastudio.id/#organization",
    });
  });

  it("maps every allowed business category safely and never allows deprecated ProfessionalService", () => {
    expect(ALLOWED_BUSINESS_SCHEMA_TYPES).not.toContain("ProfessionalService");
    expect(resolveBusinessSchemaType("ProfessionalService")).toBe("LocalBusiness");
    expect(resolveBusinessSchemaType("professional_service")).toBe("LocalBusiness");
    expect(resolveBusinessSchemaType("travel_umrah_agency")).toBe("TravelAgency");
    expect(resolveBusinessSchemaType("Organization")).toBe("Organization");
    expect(resolveBusinessSchemaType("AutoDealer")).toBe("AutoDealer");
    expect(resolveBusinessSchemaType("unknown_junk_value")).toBe("LocalBusiness");
  });
});

describe("TASK-015: WebPage, BreadcrumbList, Article/BlogPosting & FAQPage", () => {
  it("emits canonical BreadcrumbList with exact visible labels and rejects foreign breadcrumb URLs", () => {
    const res = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "post",
        pathname: "/blog/tips-seo-lokal",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      tenantId: "01JTESTTENANTALPHA00000001",
      siteName: "Alpha Studio",
      breadcrumbs: [
        { label: "Beranda", path: "/" },
        { label: "Blog", path: "/Blog/" },
        { label: "Malicious Crumb", url: "https://evil.example/hijack" },
        { label: "Tips SEO Lokal", url: "https://www.alphastudio.id/blog/tips-seo-lokal" },
      ],
      article: {
        schemaType: "BlogPosting",
        headline: "Tips SEO Lokal untuk UMKM Indonesia",
        description: "Panduan praktis membangun profil bisnis yang akurat.",
        datePublished: "2026-10-01T08:00:00.000Z",
        dateModified: "2026-10-15T10:30:00.000Z",
        authorName: "Rina Wijaya",
        authorRoleTitle: "Konsultan Pemasaran",
        section: "Pemasaran Digital",
        tags: ["SEO Lokal", "UMKM"],
        image: {
          url: "https://media.punyasitus.com/t/01JTESTTENANTALPHA00000001/media/og-tips.webp",
          width: 1200,
          height: 630,
          alt: "Ilustrasi SEO Lokal",
          tenantId: "01JTESTTENANTALPHA00000001",
          status: "ready",
        },
      },
    });

    const graph = parseAndValidateGraph(res.jsonLd);
    const breadcrumb = findNodeByType(graph, "BreadcrumbList");
    expect(breadcrumb).toEqual({
      "@type": "BreadcrumbList",
      "@id": "https://www.alphastudio.id/blog/tips-seo-lokal#breadcrumb",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Beranda",
          item: "https://www.alphastudio.id/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Blog",
          item: "https://www.alphastudio.id/blog",
        },
        {
          "@type": "ListItem",
          position: 3,
          name: "Tips SEO Lokal",
          item: "https://www.alphastudio.id/blog/tips-seo-lokal",
        },
      ],
    });

    const article = findNodeByType(graph, "BlogPosting");
    expect(article).toBeDefined();
    expect(article?.headline).toBe("Tips SEO Lokal untuk UMKM Indonesia");
    expect(article?.description).toBe("Panduan praktis membangun profil bisnis yang akurat.");
    expect(article?.mainEntityOfPage).toEqual({
      "@type": "WebPage",
      "@id": "https://www.alphastudio.id/blog/tips-seo-lokal#webpage",
      url: "https://www.alphastudio.id/blog/tips-seo-lokal",
    });
    expect(article?.datePublished).toBe("2026-10-01T08:00:00.000Z");
    expect(article?.dateModified).toBe("2026-10-15T10:30:00.000Z");
    expect(article?.author).toEqual({
      "@type": "Person",
      name: "Rina Wijaya",
      jobTitle: "Konsultan Pemasaran",
    });
    expect(article?.publisher).toEqual({
      "@id": "https://www.alphastudio.id/#organization",
    });
    expect(article?.image).toEqual({
      "@type": "ImageObject",
      url: "https://media.punyasitus.com/t/01JTESTTENANTALPHA00000001/media/og-tips.webp",
      width: 1200,
      height: 630,
      caption: "Ilustrasi SEO Lokal",
    });
    expect(article?.articleSection).toBe("Pemasaran Digital");
    expect(article?.keywords).toEqual(["SEO Lokal", "UMKM"]);
  });

  it("omits unready, trashed, or cross-tenant images from Article JSON-LD", () => {
    const tenantId = "01JTESTTENANTALPHA00000001";
    const badImages = [
      {
        url: `https://media.punyasitus.com/t/${tenantId}/media/processing.webp`,
        tenantId,
        status: "processing",
      },
      {
        url: `https://media.punyasitus.com/t/${tenantId}/media/trashed.webp`,
        tenantId,
        status: "ready",
        deletedAt: 1730000000000,
      },
      {
        url: "https://media.punyasitus.com/t/01JTESTTENANTBETA000000002/media/other.webp",
        tenantId: "01JTESTTENANTBETA000000002",
        status: "ready",
      },
      {
        url: "https://evil.example/og.webp",
        status: "ready",
      },
    ];

    for (const image of badImages) {
      const res = generateSchemaGraph({
        seo: {
          surface: "public_tenant",
          routeKind: "post",
          pathname: "/blog/artikel-uji",
          tenant: ACTIVE_CUSTOM_TENANT,
        },
        tenantId,
        siteName: "Alpha Studio",
        article: {
          headline: "Artikel Uji",
          image,
        },
      });
      const graph = parseAndValidateGraph(res.jsonLd);
      expect(findNodeByType(graph, "BlogPosting")?.image).toBeUndefined();
    }
  });

  it("emits FAQPage ONLY when visible Q&A items are non-empty and records the rich-result disclaimer", () => {
    const emptyFaq = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/faq",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Alpha Studio",
      pageTitle: "FAQ",
      pageSchemaType: "FAQPage",
      faqItems: [
        { question: "   ", answer: "Jawaban tanpa pertanyaan" },
        { question: "Pertanyaan tanpa jawaban", answer: "" },
      ],
    });
    const emptyGraph = parseAndValidateGraph(emptyFaq.jsonLd);
    expect(findNodeByType(emptyGraph, "FAQPage")).toBeUndefined();
    expect(findNodeByType(emptyGraph, "WebPage")).toBeDefined();
    expect(emptyFaq.policy.notes).not.toContain(FAQ_RICH_RESULT_NOTE);

    const populatedFaq = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/faq",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Alpha Studio",
      pageTitle: "Pertanyaan Umum",
      faqItems: [
        {
          question: "Berapa lama proses pengerjaan?",
          answer: "Estimasi pengerjaan standar adalah 7 hari kerja.",
        },
        {
          question: "Apakah bisa konsultasi via WhatsApp?",
          answer: "Ya, konsultasi awal tersedia melalui WhatsApp resmi kami.",
        },
      ],
    });

    const populatedGraph = parseAndValidateGraph(populatedFaq.jsonLd);
    const faq = findNodeByType(populatedGraph, "FAQPage");
    expect(faq).toEqual({
      "@type": "FAQPage",
      "@id": "https://www.alphastudio.id/faq#faq",
      url: "https://www.alphastudio.id/faq",
      isPartOf: { "@id": "https://www.alphastudio.id/faq#webpage" },
      mainEntity: [
        {
          "@type": "Question",
          name: "Berapa lama proses pengerjaan?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Estimasi pengerjaan standar adalah 7 hari kerja.",
          },
        },
        {
          "@type": "Question",
          name: "Apakah bisa konsultasi via WhatsApp?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Ya, konsultasi awal tersedia melalui WhatsApp resmi kami.",
          },
        },
      ],
    });
    expect(populatedFaq.policy.guaranteesRichResultEligibility).toBe(false);
    expect(populatedFaq.policy.guaranteesSearchRanking).toBe(false);
    expect(populatedFaq.policy.disclaimer).toBe(SCHEMA_RICH_RESULT_DISCLAIMER);
    expect(populatedFaq.policy.notes).toContain(FAQ_RICH_RESULT_NOTE);
  });
});

describe("TASK-015: Typed Offerings (Product, Service, TouristTrip, Vehicle) Honesty Rules", () => {
  it("emits Product with honest Offer / AggregateOffer for concrete fixed/from/range IDR prices", () => {
    const fixedRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/kopi-arabika-gayo",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Kopi Nusantara",
      offering: {
        offeringType: "product",
        title: "Kopi Arabika Gayo 250g",
        summary: "Biji kopi panggang medium asal Aceh Gayo.",
        priceMode: "fixed",
        price: 95000,
        ctaMode: "whatsapp",
        attributes: {
          sku: "KOP-GAYO-250",
          brand: "Kopi Nusantara",
          stockStatus: "ready",
          specs: [{ label: "Berat Bersih", value: "250 gram" }],
        },
      },
    });
    const fixedGraph = parseAndValidateGraph(fixedRes.jsonLd);
    const fixedProduct = findNodeByType(fixedGraph, "Product");
    expect(fixedProduct).toMatchObject({
      "@type": "Product",
      "@id": "https://www.alphastudio.id/produk/kopi-arabika-gayo#product",
      name: "Kopi Arabika Gayo 250g",
      sku: "KOP-GAYO-250",
      brand: { "@type": "Brand", name: "Kopi Nusantara" },
      offers: {
        "@type": "Offer",
        priceCurrency: "IDR",
        price: 95000,
        url: "https://www.alphastudio.id/produk/kopi-arabika-gayo",
        availability: "https://schema.org/InStock",
      },
    });
    // Never invent fake ratings, reviews, or merchant-listing checkout/shipping claims
    expect(fixedProduct?.aggregateRating).toBeUndefined();
    expect(fixedProduct?.review).toBeUndefined();
    expect((fixedProduct?.offers as Record<string, unknown>)?.shippingDetails).toBeUndefined();
    expect((fixedProduct?.offers as Record<string, unknown>)?.hasMerchantReturnPolicy).toBeUndefined();

    // `from` price -> AggregateOffer with lowPrice ONLY, and NO invented availability when omitted
    const fromRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/kemasan-custom",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Kopi Nusantara",
      offering: {
        offeringType: "product",
        title: "Kemasan Custom Standing Pouch",
        priceMode: "from",
        price: 250000,
        ctaMode: "whatsapp",
      },
    });
    const fromProduct = findNodeByType(parseAndValidateGraph(fromRes.jsonLd), "Product");
    expect(fromProduct?.offers).toEqual({
      "@type": "AggregateOffer",
      priceCurrency: "IDR",
      lowPrice: 250000,
      url: "https://www.alphastudio.id/produk/kemasan-custom",
    });

    // `range` price -> AggregateOffer with lowPrice and highPrice
    const rangeRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/mesin-espresso",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Kopi Nusantara",
      offering: {
        offeringType: "product",
        title: "Mesin Espresso Komersial",
        priceMode: "range",
        price: 15000000,
        priceMax: 35000000,
        ctaMode: "whatsapp",
      },
    });
    const rangeProduct = findNodeByType(parseAndValidateGraph(rangeRes.jsonLd), "Product");
    expect(rangeProduct?.offers).toEqual({
      "@type": "AggregateOffer",
      priceCurrency: "IDR",
      lowPrice: 15000000,
      highPrice: 35000000,
      url: "https://www.alphastudio.id/produk/mesin-espresso",
    });
  });

  it("NEVER invents numeric Offer.price for on_request or inquiry products, and NEVER invents Product/Offer for service items", () => {
    const onRequestProduct = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/panel-surya-industri",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Energi Surya",
      offering: {
        offeringType: "product",
        title: "Panel Surya Industri Custom",
        priceMode: "on_request",
        price: null,
        ctaMode: "whatsapp",
      },
    });
    const onReqNode = findNodeByType(parseAndValidateGraph(onRequestProduct.jsonLd), "Product");
    expect(onReqNode?.["@type"]).toBe("Product");
    expect(onReqNode?.offers).toBeUndefined();

    const inquiryProduct = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/mesin-cnc-b2b",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Energi Surya",
      offering: {
        offeringType: "product",
        title: "Mesin CNC B2B",
        priceMode: "fixed",
        price: 120000000,
        ctaMode: "inquiry",
      },
    });
    const inqProdNode = findNodeByType(parseAndValidateGraph(inquiryProduct.jsonLd), "Product");
    expect(inqProdNode?.["@type"]).toBe("Product");
    expect(inqProdNode?.offers).toBeUndefined();

    // Service item even with fixed price MUST emit Service and NEVER Product or Offer
    const serviceRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/layanan/audit-keuangan",
        tenant: ACTIVE_CUSTOM_TENANT,
        resourceSeo: {
          schemaType: "Product", // even if overridden, service MUST NOT become Product!
        },
      },
      siteName: "KAP Sejahtera",
      offering: {
        offeringType: "service",
        title: "Jasa Audit Laporan Keuangan",
        summary: "Audit tahunan untuk perusahaan menengah.",
        priceMode: "fixed",
        price: 15000000,
        ctaMode: "inquiry",
        categoryName: "Konsultasi Akuntansi",
        attributes: {
          serviceArea: "Jabodetabek",
        },
      },
    });
    const serviceGraph = parseAndValidateGraph(serviceRes.jsonLd);
    expect(findNodeByType(serviceGraph, "Product")).toBeUndefined();
    const serviceNode = findNodeByType(serviceGraph, "Service");
    expect(serviceNode).toEqual({
      "@type": "Service",
      "@id": "https://www.alphastudio.id/layanan/audit-keuangan#service",
      name: "Jasa Audit Laporan Keuangan",
      url: "https://www.alphastudio.id/layanan/audit-keuangan",
      description: "Audit tahunan untuk perusahaan menengah.",
      provider: { "@id": "https://www.alphastudio.id/#organization" },
      serviceType: "Konsultasi Akuntansi",
      areaServed: "Jabodetabek",
    });
    expect(serviceNode?.offers).toBeUndefined();
  });

  it("emits TouristTrip for tour offerings and OMITS past departure dates when `now` is passed", () => {
    expect(
      filterUpcomingDepartureDates(
        ["2026-01-15", "2026-11-21", "2026-11-22", "2026-12-10", "not-a-date"],
        "2026-11-22",
      ),
    ).toEqual(["2026-11-22", "2026-12-10"]);

    const tourRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/tour/explore-labuan-bajo-4h3m",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Nusantara Travel",
      timezone: "Asia/Jakarta",
      now: new Date("2026-11-22T05:00:00.000Z"), // 2026-11-22 12:00 WIB
      offering: {
        offeringType: "tour",
        title: "Explore Labuan Bajo 4H3M",
        summary: "Pelayaran phinisi ke Pulau Padar dan Komodo.",
        priceMode: "from",
        price: 4500000,
        ctaMode: "whatsapp",
        attributes: {
          destination: "Labuan Bajo, NTT",
          durationDays: 4,
          departures: [
            { departureDate: "2026-08-17", status: "open" }, // past -> OMIT
            { departureDate: "2026-11-21", status: "open" }, // yesterday -> OMIT
            { departureDate: "2026-11-22", status: "open" }, // today -> KEEP
            { departureDate: "2026-12-24", status: "limited" }, // future -> KEEP
            { departureDate: "2027-01-05", status: "closed" }, // closed -> OMIT
          ],
          departureDates: ["2026-09-01", "2026-12-31"],
          itinerary: [
            { day: 1, title: "Kedatangan & Pulau Kelor", description: "Snorkeling sore." },
            { day: 2, title: "Pulau Padar & Pink Beach" },
          ],
        },
      },
    });

    const tourGraph = parseAndValidateGraph(tourRes.jsonLd);
    expect(findNodeByType(tourGraph, "Product")).toBeUndefined();
    const trip = findNodeByType(tourGraph, "TouristTrip");
    expect(trip).toBeDefined();
    expect(trip?.duration).toBe("P4D");
    expect(trip?.departureTime).toEqual(["2026-11-22", "2026-12-24", "2026-12-31"]);
    expect(tourRes.jsonLd).not.toContain("2026-08-17");
    expect(tourRes.jsonLd).not.toContain("2026-11-21");
    expect(tourRes.jsonLd).not.toContain("2026-09-01");
    expect(tourRes.jsonLd).not.toContain("2027-01-05");
    expect(trip?.offers).toBeUndefined();

    // When all dates are in the past, departureTime is omitted completely
    const allPastTour = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/tour/lampau",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Nusantara Travel",
      now: "2026-11-22",
      offering: {
        offeringType: "tour",
        title: "Tur Musim Lalu",
        attributes: {
          departureDates: ["2025-12-01", "2026-05-01"],
        },
      },
    });
    const allPastTrip = findNodeByType(parseAndValidateGraph(allPastTour.jsonLd), "TouristTrip");
    expect(allPastTrip?.departureTime).toBeUndefined();
  });

  it("emits Car / Vehicle with honest visible specs, omits Offer for on_request/inquiry, and omits financing data", () => {
    const usedCarRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/kendaraan/toyota-innova-zenix-2024",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Bintang Motor",
      offering: {
        offeringType: "vehicle",
        title: "Toyota Kijang Innova Zenix Hybrid 2024",
        summary: "Unit terawat tangan pertama, servis resmi.",
        priceMode: "fixed",
        price: 485000000,
        ctaMode: "whatsapp",
        unitStatus: "available",
        attributes: {
          brand: "Toyota",
          model: "Innova Zenix",
          variant: "Q Hybrid Modellista",
          year: 2024,
          condition: "used",
          mileageKm: 18500,
          transmission: "cvt",
          fuelType: "hybrid",
          bodyType: "mpv",
          color: "Putih Mutiara",
          seats: 7,
          engineCc: 1987,
          ownershipCount: 1,
          creditEstimateEnabled: true,
          creditEstimateConfig: {
            annualFlatRateBps: 650,
            dpPercents: [20, 30],
            tenorMonths: [36, 48],
          },
        },
      },
    });

    const carGraph = parseAndValidateGraph(usedCarRes.jsonLd);
    const car = findNodeByType(carGraph, "Car");
    expect(car).toMatchObject({
      "@type": "Car",
      "@id": "https://www.alphastudio.id/kendaraan/toyota-innova-zenix-2024#vehicle",
      brand: { "@type": "Brand", name: "Toyota" },
      model: "Innova Zenix",
      vehicleConfiguration: "Q Hybrid Modellista",
      vehicleModelDate: "2024",
      itemCondition: "https://schema.org/UsedCondition",
      mileageFromOdometer: {
        "@type": "QuantitativeValue",
        value: 18500,
        unitCode: "KMT",
      },
      vehicleTransmission: "CVT",
      fuelType: "Hybrid",
      bodyType: "mpv",
      color: "Putih Mutiara",
      vehicleSeatingCapacity: 7,
      numberOfPreviousOwners: 1,
      offers: {
        "@type": "Offer",
        priceCurrency: "IDR",
        price: 485000000,
        url: "https://www.alphastudio.id/kendaraan/toyota-innova-zenix-2024",
        availability: "https://schema.org/InStock",
      },
    });
    // REQ-079: never emit financing structured data
    expect(usedCarRes.jsonLd).not.toContain("LoanOrCredit");
    expect(usedCarRes.jsonLd).not.toContain("annualFlatRateBps");

    // Motorcycle / on_request / new unit -> Vehicle, no mileage, no Offer
    const newMotoRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/kendaraan/yamaha-nmax-turbo",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Bintang Motor",
      offering: {
        offeringType: "vehicle",
        title: "Yamaha NMAX Turbo 2026",
        priceMode: "on_request",
        price: null,
        ctaMode: "inquiry",
        unitStatus: "sold",
        attributes: {
          brand: "Yamaha",
          model: "NMAX Turbo",
          year: 2026,
          condition: "new",
          mileageKm: 100, // ignored for new condition
          bodyType: "matic",
          transmission: "cvt",
          fuelType: "bensin",
        },
      },
    });
    const motoNode = findNodeByType(parseAndValidateGraph(newMotoRes.jsonLd), "Vehicle");
    expect(motoNode).toBeDefined();
    expect(motoNode?.itemCondition).toBe("https://schema.org/NewCondition");
    expect(motoNode?.mileageFromOdometer).toBeUndefined();
    expect(motoNode?.offers).toBeUndefined();
  });
});

describe("TASK-015: Safe XSS Escaping & Published Resource Adapter", () => {
  it("escapes </script>, <!--, -->, <, >, &, U+2028, and U+2029 safely while keeping valid JSON", () => {
    const xssPayload =
      'Promo </script><script>alert(1)</script> <!-- comment --> A & B \u2028 line \u2029 para';

    const res = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "post",
        pathname: "/blog/uji-keamanan",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: "Alpha & Co <Studio>",
      article: {
        headline: xssPayload,
        description: "Test <!-- --> </script><img src=x onerror=alert(1)>",
        authorName: "Budi </script> Santoso",
      },
      faqItems: [
        {
          question: "Aman dari </script>?",
          answer: "Ya, <!-- aman --> & terenkode.",
        },
      ],
    });

    expect(res.emitted).toBe(true);
    expect(res.jsonLd).not.toBeNull();
    expect(res.scriptTag).not.toBeNull();

    // Raw JSON-LD string MUST NOT contain unescaped breakout sequences
    expect(res.jsonLd!).not.toContain("<");
    expect(res.jsonLd!).not.toContain(">");
    expect(res.jsonLd!).not.toContain("&");
    expect(res.jsonLd!).not.toContain("</script>");
    expect(res.jsonLd!).not.toContain("<!--");
    expect(res.jsonLd!).not.toContain("-->");
    expect(res.jsonLd!).not.toContain("\u2028");
    expect(res.jsonLd!).not.toContain("\u2029");

    // Script tag contains only the single wrapping script pair
    const scriptMatches = res.scriptTag!.match(/<\/script>/gi) ?? [];
    expect(scriptMatches).toHaveLength(1);

    // Must parse cleanly with JSON.parse
    const parsed = parseAndValidateGraph(res.jsonLd);
    expect(findNodeByType(parsed, "BlogPosting")?.headline).toContain("</script><script>alert(1)</script>");

    // Direct serializeSchemaGraph preserves explicit \u2028 / \u2029 JSON escapes
    const directSerialized = serializeSchemaGraph({
      "@context": SCHEMA_ORG_CONTEXT,
      "@graph": [
        {
          "@type": "WebPage",
          name: "A\u2028B\u2029</script><!--&-->",
        },
      ],
    });
    expect(directSerialized).toContain("\\u2028");
    expect(directSerialized).toContain("\\u2029");
    expect(directSerialized).toContain("\\u003c/script\\u003e");
    expect(directSerialized).toContain("\\u003c!--\\u0026--\\u003e");
    expect(directSerialized).not.toContain("\u2028");
    expect(directSerialized).not.toContain("\u2029");
    expect(JSON.parse(directSerialized)).toEqual({
      "@context": SCHEMA_ORG_CONTEXT,
      "@graph": [
        {
          "@type": "WebPage",
          name: "A\u2028B\u2029</script><!--&-->",
        },
      ],
    });
  });

  it("integrates cleanly with @punyasitus/core/content DTOs and renderSeoHeadHtml", () => {
    const siteSettings: SiteSettingsSnapshot = {
      siteTitle: "Alpha Studio",
      tagline: "Studio Arsitektur",
      timezone: "Asia/Jakarta",
      locale: "id-ID",
      activeThemeId: "compro",
      blogEnabled: true,
      catalogEnabled: true,
      aiTrainingPolicy: "allow",
      siteVisibility: "public",
    };

    const businessProfile: BusinessProfileSnapshot = {
      businessName: "PT Alpha Studio",
      businessCategory: "LocalBusiness",
      description: "Studio desain dan arsitektur di Bandung.",
      address: "Jl. Braga No. 88",
      city: "Bandung",
      province: "Jawa Barat",
      serviceAreas: ["Bandung"],
      phone: "6281234567890",
      socialLinks: [{ platform: "instagram", url: "https://instagram.com/alphastudio" }],
    };

    const publishedPage: PublishedResourceDto<"page"> = {
      resourceType: "page",
      resourceId: 1,
      version: 2,
      publishedAt: Date.parse("2026-10-01T00:00:00.000Z"),
      contentModifiedAt: Date.parse("2026-10-10T00:00:00.000Z"),
      data: {
        slug: "tentang-kami",
        title: "Tentang Kami",
        isHomepage: false,
        layoutMode: "standard",
        sections: [],
        seo: {
          schemaType: "AboutPage",
          descriptionOverride: "Profil perusahaan PT Alpha Studio.",
        },
      } satisfies PageSnapshot,
    };

    const pageRes = generatePublishedResourceSchema({
      tenant: ACTIVE_CUSTOM_TENANT,
      siteSettings,
      businessProfile,
      resource: publishedPage,
      breadcrumbs: [
        { label: "Beranda", path: "/" },
        { label: "Tentang Kami", path: "/tentang-kami" },
      ],
    });

    const pageGraph = parseAndValidateGraph(pageRes.jsonLd);
    expect(findNodeByType(pageGraph, "AboutPage")?.url).toBe(
      "https://www.alphastudio.id/tentang-kami",
    );
    expect(findNodeByType(pageGraph, "BreadcrumbList")).toBeDefined();

    // Compatibility with TASK-016 `renderSeoHeadHtml`
    const ogDto = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/tentang-kami",
        tenant: ACTIVE_CUSTOM_TENANT,
      },
      siteName: siteSettings.siteTitle,
      resourceTitle: "Tentang Kami",
    });
    const headHtml = renderSeoHeadHtml(ogDto, { jsonLd: pageRes.graph });
    expect(headHtml).toContain('<script type="application/ld+json">');
    expect(headHtml).toContain("https://www.alphastudio.id/tentang-kami");

    // Disabled blog returns suppressed empty JSON-LD
    const publishedPost: PublishedResourceDto<"post"> = {
      resourceType: "post",
      resourceId: 10,
      version: 1,
      publishedAt: Date.parse("2026-10-05T00:00:00.000Z"),
      contentModifiedAt: Date.parse("2026-10-05T00:00:00.000Z"),
      data: {
        slug: "berita-terbaru",
        title: "Berita Terbaru",
        body: { schemaVersion: 1, blocks: [] },
        readingTimeMinutes: 3,
        showToc: false,
      } satisfies PostSnapshot,
    };
    const disabledBlogRes = generatePublishedResourceSchema({
      tenant: ACTIVE_CUSTOM_TENANT,
      siteSettings: { ...siteSettings, blogEnabled: false },
      resource: publishedPost,
    });
    expect(disabledBlogRes.emitted).toBe(false);
    expect(disabledBlogRes.jsonLd).toBeNull();

    // Published offering via adapter
    const publishedOffering: PublishedResourceDto<"offering"> = {
      resourceType: "offering",
      resourceId: 5,
      version: 1,
      publishedAt: Date.parse("2026-10-05T00:00:00.000Z"),
      contentModifiedAt: Date.parse("2026-10-05T00:00:00.000Z"),
      data: {
        offeringType: "tour",
        slug: "bromo-sunrise",
        title: "Bromo Sunrise 2H1M",
        summary: "Paket wisata Gunung Bromo.",
        galleryMediaIds: [],
        priceMode: "from",
        price: 1200000,
        negotiable: false,
        ctaMode: "whatsapp",
        attributesVersion: 1,
        attributes: {
          destination: "Gunung Bromo",
          durationDays: 2,
          departureDates: ["2026-10-01", "2026-12-15"],
        },
      } satisfies OfferingSnapshot,
    };
    const offeringRes = generatePublishedResourceSchema({
      tenant: ACTIVE_CUSTOM_TENANT,
      siteSettings,
      businessProfile,
      resource: publishedOffering,
      now: "2026-11-22",
    });
    const offeringGraph = parseAndValidateGraph(offeringRes.jsonLd);
    expect(findNodeByType(offeringGraph, "TouristTrip")?.departureTime).toEqual(["2026-12-15"]);

    // Null resource (draft/missing) emits nothing
    const missingRes = generatePublishedResourceSchema({
      tenant: ACTIVE_CUSTOM_TENANT,
      siteSettings,
      resource: null,
    });
    expect(missingRes.emitted).toBe(false);
    expect(missingRes.jsonLd).toBeNull();
  });
});
