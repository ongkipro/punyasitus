import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CloudflareImagesBinding, CloudflareImagesTransformOptions } from "@punyasitus/core/media/index";
import {
  DEFAULT_MEDIA_CDN_ORIGIN,
  DEFAULT_OG_LOCALE,
  generateOpenGraphMetadata,
  normalizeOgLocale,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_MAX_BYTES,
  OG_IMAGE_WIDTH,
  renderSeoHeadHtml,
  serializeJsonLdBlocks,
  validateOgImageCandidate,
  type OgImageCandidate,
} from "@punyasitus/core/og-generator";
import {
  INDEXABLE_ROBOTS_DIRECTIVES,
  SeoPolicyError,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
import { describe, expect, it } from "vitest";
import {
  generateOgDerivative,
  OG_QUALITY_LADDER,
} from "../../apps/web/src/worker/queues/media/og.ts";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");

const TENANT_ID_A = "01JT016UNIT0TENANTA0000001";
const TENANT_ID_B = "01JT016UNIT0TENANTB0000002";

const PAID_CUSTOM_TENANT: VerifiedTenantHostInput = {
  tenantHandle: "t016-alpha",
  tenantStatus: "active",
  primaryHost: "www.alphabrand.id",
  primaryHostKind: "custom",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["www.alphabrand.id", "t016-alpha.situsku.click"],
};

const PAID_SUBDOMAIN_TENANT: VerifiedTenantHostInput = {
  tenantHandle: "t016-sub",
  tenantStatus: "active",
  primaryHost: "t016-sub.situsku.click",
  primaryHostKind: "subdomain",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
  verifiedTenantHosts: ["t016-sub.situsku.click"],
};

const TRIAL_TENANT: VerifiedTenantHostInput = {
  tenantHandle: "t016-trial",
  tenantStatus: "trial",
  primaryHost: "t016-trial.situsku.click",
  primaryHostKind: "subdomain",
  primaryHostStatus: "active",
  primaryHostSslStatus: "active",
  primaryHostVerified: true,
};

function makeReadyOgCandidate(overrides: Partial<OgImageCandidate> = {}): OgImageCandidate {
  return {
    tenantId: TENANT_ID_A,
    status: "ready",
    dbStatus: "ready",
    deletedAt: null,
    r2Key: `t/${TENANT_ID_A}/media/10/hero-banner-og.webp`,
    url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ID_A}/media/10/hero-banner-og.webp`,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    byteSize: 184_320,
    mimeType: "image/webp",
    alt: "Hero Banner Alpha Brand",
    ...overrides,
  };
}

function makeValidWebpVp8X(width: number, height: number, totalSize: number): Uint8Array {
  const size = Math.max(30, totalSize);
  const buf = new Uint8Array(size);
  const enc = new TextEncoder();
  buf.set(enc.encode("RIFF"), 0);
  const view = new DataView(buf.buffer);
  view.setUint32(4, size - 8, true);
  buf.set(enc.encode("WEBP"), 8);
  buf.set(enc.encode("VP8X"), 12);
  view.setUint32(16, 10, true);
  const wMinus1 = Math.max(0, width - 1);
  const hMinus1 = Math.max(0, height - 1);
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
  return buf;
}

function makeMockImagesBinding(
  byteSizeByQuality: (quality: number, transform: CloudflareImagesTransformOptions) => {
    readonly bytes: Uint8Array;
  },
): {
  readonly binding: CloudflareImagesBinding;
  readonly calls: Array<{
    readonly transform: CloudflareImagesTransformOptions;
    readonly format: string;
    readonly quality: number | undefined;
  }>;
} {
  const calls: Array<{
    readonly transform: CloudflareImagesTransformOptions;
    readonly format: string;
    readonly quality: number | undefined;
  }> = [];

  const binding: CloudflareImagesBinding = {
    input() {
      let currentTransform: CloudflareImagesTransformOptions = {};
      return {
        transform(options) {
          currentTransform = { ...currentTransform, ...options };
          return this;
        },
        async output(outputOpts) {
          calls.push({
            transform: currentTransform,
            format: outputOpts.format,
            quality: outputOpts.quality,
          });
          const { bytes } = byteSizeByQuality(outputOpts.quality ?? 80, currentTransform);
          return {
            image() {
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              });
            },
            response() {
              return new Response(new Uint8Array(bytes).buffer, {
                headers: { "Content-Type": outputOpts.format },
              });
            },
            contentType() {
              return outputOpts.format;
            },
          };
        },
      };
    },
  };

  return { binding, calls };
}

describe("TASK-016: Open Graph & Social Share Metadata Generator (Unit)", () => {
  it("enforces verified canonical host, strips tracking query params, and rejects malicious host strings", () => {
    const customMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/Tentang-Kami/",
        query: "?utm_source=wa&fbclid=abc123&gclid=xyz",
        tenant: PAID_CUSTOM_TENANT,
        siteVisibility: "public",
        resourceState: "published",
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      resourceTitle: "Tentang Kami",
      resourceExcerpt: "Profil perusahaan konstruksi B2B terpercaya di Indonesia.",
      resourceOgImage: makeReadyOgCandidate(),
    });

    expect(customMeta.canonical).toBe("https://www.alphabrand.id/tentang-kami");
    expect(customMeta.og.url).toBe("https://www.alphabrand.id/tentang-kami");
    expect(customMeta.robots).toBe(INDEXABLE_ROBOTS_DIRECTIVES);
    expect(customMeta.og.type).toBe("website");
    expect(customMeta.og.locale).toBe(DEFAULT_OG_LOCALE);
    expect(customMeta.og.image?.url).toBe(
      `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ID_A}/media/10/hero-banner-og.webp`,
    );
    expect(customMeta.og.image?.width).toBe(1200);
    expect(customMeta.og.image?.height).toBe(630);
    expect(customMeta.twitter.card).toBe("summary_large_image");

    // Unverified custom host MUST fall back to verified *.situsku.click (never trust unverified domain)
    const unverifiedMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: {
          ...PAID_CUSTOM_TENANT,
          primaryHostVerified: false,
        },
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
    });
    expect(unverifiedMeta.canonical).toBe("https://t016-alpha.situsku.click/");
    expect(unverifiedMeta.og.url).toBe("https://t016-alpha.situsku.click/");

    // Malicious / spoofed host strings MUST throw SeoPolicyError
    const maliciousHosts = [
      "javascript:alert(1)",
      "http://evil.example",
      "127.0.0.1",
      "evil.example@www.alphabrand.id",
      "www.alphabrand.id\r\nX-Injected: 1",
      "other-tenant.situsku.click",
      "www.evil-attacker.example",
    ];
    for (const badHost of maliciousHosts) {
      expect(() =>
        generateOpenGraphMetadata({
          seo: {
            surface: "public_tenant",
            routeKind: "homepage",
            pathname: "/",
            tenant: {
              ...PAID_CUSTOM_TENANT,
              primaryHost: badHost,
            },
          },
          tenantId: TENANT_ID_A,
          siteName: "Alpha Brand",
        }),
      ).toThrow(SeoPolicyError);
    }
  });

  it("escapes hostile HTML attribute, title, and JSON-LD XSS payloads cleanly", () => {
    const hostileTitle = `Promo " onclick="alert(1)</title><script>window.__xss=1</script>`;
    const hostileDesc = `Penawaran ' onmouseover='evil()' & <b>hebat</b>\r\n\0<!-- breakout -->`;
    const hostileAlt = `Foto " onerror="alert(2) <img src=x>`;

    const meta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/promo",
        tenant: PAID_SUBDOMAIN_TENANT,
        resourceState: "published",
      },
      tenantId: TENANT_ID_A,
      siteName: `Toko "Keren" & <Aman>`,
      resourceTitle: hostileTitle,
      resourceExcerpt: hostileDesc,
      resourceOgImage: makeReadyOgCandidate({ alt: hostileAlt }),
    });

    // Control chars (\r, \n, \0) must be stripped at DTO level
    expect(meta.description).not.toMatch(/[\r\n\0]/);

    const html = renderSeoHeadHtml(meta, {
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: `</script><script>alert("xss")</script><!--`,
        url: meta.canonical,
      },
    });

    // Zero raw unescaped tags or attribute breakouts
    expect(html).not.toContain("<script>window.__xss");
    expect(html).not.toContain('alert("xss")</script>');
    expect(html).not.toContain("</title><script>");
    expect(html).not.toContain('" onclick="');
    expect(html).not.toContain('" onerror="');
    expect(html).not.toContain("<!-- breakout");
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(html).toContain("\\u003c/script\\u003e");

    // JSON-LD block must still parse as 100% valid JSON
    const blocks = serializeJsonLdBlocks({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: `</script><script>alert(1)</script>`,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain("</script>");
    expect(JSON.parse(blocks[0]!)).toMatchObject({
      "@type": "WebPage",
      name: `</script><script>alert(1)</script>`,
    });
  });

  it("enforces exact 1200x630 <= 300 KiB (307,200 B), ready status, tenant ownership, and safe fallback chain", () => {
    const exactBudget = makeReadyOgCandidate({ byteSize: OG_IMAGE_MAX_BYTES }); // 307,200 bytes
    const defaultCandidate = makeReadyOgCandidate({
      r2Key: `t/${TENANT_ID_A}/media/1/default-brand-og.webp`,
      url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ID_A}/media/1/default-brand-og.webp`,
      byteSize: 95_000,
      alt: "Default Brand Card",
    });
    const platformFallback: OgImageCandidate = {
      isPlatformFallback: true,
      url: `${DEFAULT_MEDIA_CDN_ORIGIN}/platform/og-default-1200x630.webp`,
      width: 1200,
      height: 630,
      byteSize: 42_000,
      mimeType: "image/webp",
      alt: "Platform Safe Fallback",
    };

    // 1. Exact 307,200-byte ready 1200x630 resource image passes
    const exactOk = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: PAID_CUSTOM_TENANT,
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      resourceOgImage: exactBudget,
      tenantDefaultOgImage: defaultCandidate,
      platformFallbackOgImage: platformFallback,
    });
    expect(exactOk.og.image?.source).toBe("resource");
    expect(exactOk.og.image?.byteSize).toBe(307_200);
    expect(exactOk.twitter.card).toBe("summary_large_image");

    // 2. 307,201 bytes (1 byte over 300 KiB) -> rejected -> falls back to tenant default
    const oversized = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: PAID_CUSTOM_TENANT,
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      resourceOgImage: makeReadyOgCandidate({ byteSize: OG_IMAGE_MAX_BYTES + 1 }),
      tenantDefaultOgImage: defaultCandidate,
    });
    expect(oversized.og.image?.source).toBe("tenant_default");
    expect(oversized.og.image?.url).toBe(defaultCandidate.url);
    expect(oversized.imageRejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ slot: "resource", reason: "oversized" })]),
    );

    // 3. Non-ready statuses (processing/failed/quarantined/trashed/deletedAt) rejected
    for (const badStatus of ["processing", "failed", "quarantined", "trashed"] as const) {
      const res = generateOpenGraphMetadata({
        seo: {
          surface: "public_tenant",
          routeKind: "page",
          pathname: "/layanan",
          tenant: PAID_CUSTOM_TENANT,
        },
        tenantId: TENANT_ID_A,
        siteName: "Alpha Brand",
        resourceOgImage: makeReadyOgCandidate({ status: badStatus }),
        tenantDefaultOgImage: defaultCandidate,
      });
      expect(res.og.image?.source).toBe("tenant_default");
    }

    // 4. Cross-tenant media (tenantId mismatch OR foreign R2 key OR foreign URL path) rejected
    const crossTenantCases: OgImageCandidate[] = [
      makeReadyOgCandidate({ tenantId: TENANT_ID_B }),
      makeReadyOgCandidate({ r2Key: `t/${TENANT_ID_B}/media/10/stolen-og.webp` }),
      makeReadyOgCandidate({
        url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ID_B}/media/10/stolen-og.webp`,
      }),
      makeReadyOgCandidate({
        r2Key: `t/${TENANT_ID_A}/quarantine/abc/raw.jpg`,
        url: `${DEFAULT_MEDIA_CDN_ORIGIN}/t/${TENANT_ID_A}/quarantine/abc/raw.jpg`,
      }),
      makeReadyOgCandidate({
        url: "https://evil.example/t/01JT016UNIT0TENANTA0000001/media/10/og.webp",
      }),
      makeReadyOgCandidate({
        url: "http://media.punyasitus.com/t/01JT016UNIT0TENANTA0000001/media/10/og.webp",
      }),
      makeReadyOgCandidate({
        url: "javascript:alert(1)",
      }),
      makeReadyOgCandidate({
        width: 800,
        height: 600,
      }),
      makeReadyOgCandidate({
        mimeType: "image/svg+xml",
      }),
    ];

    for (const badCandidate of crossTenantCases) {
      const res = generateOpenGraphMetadata({
        seo: {
          surface: "public_tenant",
          routeKind: "page",
          pathname: "/produk",
          tenant: PAID_CUSTOM_TENANT,
        },
        tenantId: TENANT_ID_A,
        siteName: "Alpha Brand",
        resourceOgImage: badCandidate,
        tenantDefaultOgImage: null,
        platformFallbackOgImage: platformFallback,
      });
      expect(res.og.image?.source).toBe("platform_fallback");
      expect(res.og.image?.url).toBe(platformFallback.url);
    }

    // 5. When NO eligible image exists at all -> omit og:image cleanly and downgrade twitter:card to "summary"
    const noImage = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/kontak",
        tenant: PAID_CUSTOM_TENANT,
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      resourceOgImage: makeReadyOgCandidate({ byteSize: 450_000 }),
      tenantDefaultOgImage: makeReadyOgCandidate({ status: "quarantined" }),
      platformFallbackOgImage: null,
    });
    expect(noImage.og.image).toBeNull();
    expect(noImage.twitter.card).toBe("summary");
    expect(noImage.twitter.image).toBeNull();

    const noImageHtml = renderSeoHeadHtml(noImage);
    expect(noImageHtml).not.toContain('property="og:image"');
    expect(noImageHtml).not.toContain('name="twitter:image"');
    expect(noImageHtml).toContain('<meta name="twitter:card" content="summary" />');

    // Direct validator check for jpeg/png allowed on tenant's verified origin
    const onTenantOrigin = validateOgImageCandidate(
      makeReadyOgCandidate({
        url: "https://www.alphabrand.id/assets/share-card.png",
        mimeType: "image/png",
        r2Key: null,
      }),
      {
        tenantId: TENANT_ID_A,
        allowedOrigins: new Set(["https://www.alphabrand.id", DEFAULT_MEDIA_CDN_ORIGIN]),
        defaultAlt: "Fallback Alt",
        slot: "resource",
      },
    );
    expect(onTenantOrigin.ok).toBe(true);
    if (onTenantOrigin.ok) {
      expect(onTenantOrigin.image.type).toBe("image/png");
    }
  });

  it("enforces noindex + null canonical on draft/preview/private/error/suspended/unknown_host and noindex on trial", () => {
    const noCanonicalCases: Array<{
      readonly label: string;
      readonly seo: Parameters<typeof generateOpenGraphMetadata>[0]["seo"];
    }> = [
      {
        label: "draft resource",
        seo: {
          surface: "public_tenant",
          routeKind: "page",
          pathname: "/rahasia",
          tenant: PAID_CUSTOM_TENANT,
          resourceState: "draft",
        },
      },
      {
        label: "admin preview",
        seo: {
          surface: "preview",
          routeKind: "preview",
          pathname: "/preview/page/1",
          tenant: PAID_CUSTOM_TENANT,
        },
      },
      {
        label: "private route",
        seo: {
          surface: "app",
          routeKind: "private",
          pathname: "/dashboard/t016-alpha/pages",
          tenant: PAID_CUSTOM_TENANT,
        },
      },
      {
        label: "error 404",
        seo: {
          surface: "error",
          routeKind: "error_404",
          pathname: "/tidak-ada",
          tenant: PAID_CUSTOM_TENANT,
        },
      },
      {
        label: "suspended tenant",
        seo: {
          surface: "public_tenant",
          routeKind: "homepage",
          pathname: "/",
          tenant: { ...PAID_CUSTOM_TENANT, tenantStatus: "suspended" },
        },
      },
      {
        label: "unknown host",
        seo: {
          surface: "public_tenant",
          routeKind: "unknown_host",
          pathname: "/",
          tenant: null,
        },
      },
    ];

    for (const testCase of noCanonicalCases) {
      const meta = generateOpenGraphMetadata({
        seo: testCase.seo,
        tenantId: TENANT_ID_A,
        siteName: "Alpha Brand",
        resourceTitle: "Rahasia Draf",
        resourceOgImage: makeReadyOgCandidate(),
      });
      expect(meta.robots, testCase.label).toBe("noindex, nofollow");
      expect(meta.canonical, testCase.label).toBeNull();
      expect(meta.og.url, testCase.label).toBeNull();

      const html = renderSeoHeadHtml(meta);
      expect(html, testCase.label).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(html, testCase.label).not.toContain('rel="canonical"');
      expect(html, testCase.label).not.toContain('property="og:url"');
    }

    // Draft public 404 MUST NOT leak draft title or draft image
    const draftPublic = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "page",
        pathname: "/draf-belum-terbit",
        tenant: PAID_CUSTOM_TENANT,
        resourceState: "draft",
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      resourceTitle: "JUDUL DRAF RAHASIA",
      resourceOgImage: makeReadyOgCandidate(),
    });
    expect(draftPublic.title).not.toContain("JUDUL DRAF RAHASIA");
    expect(draftPublic.og.image).toBeNull();

    // Trial tenant: ALWAYS noindex, nofollow + subdomain-only canonical
    const trialMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: TRIAL_TENANT,
      },
      tenantId: TENANT_ID_A,
      siteName: "Toko Uji Coba",
    });
    expect(trialMeta.robots).toBe("noindex, nofollow");
    expect(trialMeta.canonical).toBe("https://t016-trial.situsku.click/");
    expect(trialMeta.og.url).toBe("https://t016-trial.situsku.click/");
  });

  it("supports website, article (with timestamps/tags), product variants, pagination prev/next, and locale normalization", () => {
    // 1. Article variant
    const articleMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "post",
        pathname: "/blog/tips-bangun-kantor",
        tenant: PAID_CUSTOM_TENANT,
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      locale: "id-ID",
      resourceTitle: "Tips Bangun Kantor Modern 2026",
      resourceExcerpt: "Panduan praktis perencanaan renovasi kantor hemat biaya.",
      article: {
        publishedTime: "2026-10-01T08:30:00Z",
        modifiedTime: 1_791_000_000_000,
        author: "Tim Arsitektur Alpha",
        section: "Panduan Konstruksi",
        tags: ["Arsitektur", "Kantor", "arsitektur"],
      },
      resourceOgImage: makeReadyOgCandidate(),
    });
    expect(articleMeta.og.type).toBe("article");
    expect(articleMeta.og.locale).toBe("id_ID");
    expect(articleMeta.og.article?.publishedTime).toBe("2026-10-01T08:30:00.000Z");
    expect(articleMeta.og.article?.modifiedTime).toBe(new Date(1_791_000_000_000).toISOString());
    expect(articleMeta.og.article?.author).toBe("Tim Arsitektur Alpha");
    expect(articleMeta.og.article?.section).toBe("Panduan Konstruksi");
    expect(articleMeta.og.article?.tags).toEqual(["Arsitektur", "Kantor"]);

    const articleHtml = renderSeoHeadHtml(articleMeta);
    expect(articleHtml).toContain('<meta property="og:type" content="article" />');
    expect(articleHtml).toContain(
      '<meta property="article:published_time" content="2026-10-01T08:30:00.000Z" />',
    );
    expect(articleHtml).toContain('<meta property="article:modified_time"');
    expect(articleHtml).toContain('<meta property="article:tag" content="Arsitektur" />');

    // 2. Product variant vs service offering (service stays "website")
    const productMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/produk/mesin-kopi-pro",
        tenant: PAID_CUSTOM_TENANT,
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      offeringType: "product",
      resourceTitle: "Mesin Kopi Pro",
    });
    expect(productMeta.og.type).toBe("product");
    expect(productMeta.og.article).toBeNull();

    const serviceMeta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "offering",
        pathname: "/layanan/konsultasi-interior",
        tenant: PAID_CUSTOM_TENANT,
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      offeringType: "service",
      resourceTitle: "Konsultasi Interior",
    });
    expect(serviceMeta.og.type).toBe("website");

    // 3. Pagination prev/next links & Halaman N title qualifier
    const page2Meta = generateOpenGraphMetadata({
      seo: {
        surface: "public_tenant",
        routeKind: "blog_index",
        pathname: "/blog",
        query: "?page=2&utm_campaign=launch",
        tenant: PAID_CUSTOM_TENANT,
        publishedItemCount: 36,
        totalPages: 4,
      },
      tenantId: TENANT_ID_A,
      siteName: "Alpha Brand",
      resourceTitle: "Blog",
    });
    expect(page2Meta.canonical).toBe("https://www.alphabrand.id/blog?page=2");
    expect(page2Meta.prevUrl).toBe("https://www.alphabrand.id/blog");
    expect(page2Meta.nextUrl).toBe("https://www.alphabrand.id/blog?page=3");
    expect(page2Meta.title).toContain("Halaman 2");

    const page2Html = renderSeoHeadHtml(page2Meta);
    expect(page2Html).toContain('<link rel="prev" href="https://www.alphabrand.id/blog" />');
    expect(page2Html).toContain('<link rel="next" href="https://www.alphabrand.id/blog?page=3" />');

    // Locale normalization helper
    expect(normalizeOgLocale("id-ID")).toBe("id_ID");
    expect(normalizeOgLocale("en-US")).toBe("en_US");
    expect(normalizeOgLocale("invalid!!")).toBe("id_ID");
  });

  it("steps down WebP quality cleanly in generateOgDerivative until <= 300 KiB and fails safely when still over budget", async () => {
    const sourceBytes = makeValidWebpVp8X(2400, 1600, 1024);

    // Quality 82 -> 380 KiB (too large), 72 -> 310 KiB (too large), 62 -> 240 KiB (fits!)
    const stepDownMock = makeMockImagesBinding((quality) => {
      if (quality >= 80) return { bytes: makeValidWebpVp8X(1200, 630, 380_000) };
      if (quality >= 70) return { bytes: makeValidWebpVp8X(1200, 630, 310_000) };
      return { bytes: makeValidWebpVp8X(1200, 630, 240_000) };
    });

    const stepped = await generateOgDerivative(stepDownMock.binding, sourceBytes);
    expect(stepped.ok).toBe(true);
    if (stepped.ok) {
      expect(stepped.width).toBe(1200);
      expect(stepped.height).toBe(630);
      expect(stepped.byteLength).toBe(240_000);
      expect(stepped.byteLength).toBeLessThanOrEqual(OG_IMAGE_MAX_BYTES);
      expect(stepped.qualityUsed).toBe(62);
      expect(stepped.attempts).toBe(3);
    }
    expect(stepDownMock.calls[0]?.transform).toMatchObject({
      width: 1200,
      height: 630,
      fit: "cover",
      metadata: "none",
      anim: false,
    });

    // Always oversized (> 300 KiB at every quality step) -> fails cleanly without throwing
    const alwaysOverMock = makeMockImagesBinding(() => ({
      bytes: makeValidWebpVp8X(1200, 630, OG_IMAGE_MAX_BYTES + 1),
    }));
    const failedOver = await generateOgDerivative(alwaysOverMock.binding, sourceBytes);
    expect(failedOver.ok).toBe(false);
    if (!failedOver.ok) {
      expect(failedOver.code).toBe("OG_BUDGET_EXCEEDED");
      expect(failedOver.attempts).toBe(OG_QUALITY_LADDER.length);
    }

    // Wrong dimensions returned by binding -> rejected cleanly
    const wrongDimsMock = makeMockImagesBinding(() => ({
      bytes: makeValidWebpVp8X(800, 600, 80_000),
    }));
    const failedDims = await generateOgDerivative(wrongDimsMock.binding, sourceBytes);
    expect(failedDims.ok).toBe(false);
    if (!failedDims.ok) {
      expect(failedDims.code).toBe("INVALID_OUTPUT_DIMENSIONS");
    }
  });

  it("compiles and renders real SEOHead.astro inside Layout.astro via Astro SSR build", async () => {
    const requireFromWeb = createRequire(path.join(webDir, "package.json"));
    const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;
    const astroMod = (await import(astroEntryUrl)) as {
      build: (config: Record<string, unknown>) => Promise<void>;
    };

    const astroWorkBase = path.join(webDir, ".astro");
    fs.mkdirSync(astroWorkBase, { recursive: true });
    const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t016-unit-"));
    const srcDir = path.join(tmpRoot, "src");
    const pagesDir = path.join(srcDir, "pages");
    const outDir = path.join(tmpRoot, "dist");
    const cacheDir = path.join(tmpRoot, "cache");
    fs.mkdirSync(pagesDir, { recursive: true });

    const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
    const seoHeadImport = path.join(webDir, "src/components/SEOHead.astro");
    const publicDataImport = path.join(webDir, "src/core/public-data.ts");

    const baseShellSnippet = `
const themeStyle = buildSafeThemeStyleBlock(null, "compro");
const baseShell = {
  isPreview: false,
  layoutMode: "standard",
  themeId: "compro",
  baseThemeId: "compro",
  themeStyle,
  site: {
    title: "Alpha Brand",
    tagline: "Solusi Konstruksi B2B",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
    blogEnabled: true,
    catalogEnabled: true,
    siteVisibility: "public",
    analyticsConfig: null,
  },
  business: {
    name: "PT Alpha Brand",
    category: "LocalBusiness",
    description: "Mitra konstruksi terpercaya.",
    address: null,
    city: "Jakarta",
    province: null,
    postalCode: null,
    mapsUrl: null,
    weekdayHours: null,
    holidayHours: null,
    phone: null,
    whatsappE164: null,
    email: null,
    socialLinks: [],
  },
  menus: { header: [], footer: [], mobile: [] },
  page: null,
  revisions: { siteSettingsVersion: 1, businessProfileVersion: 1, themeConfigVersion: 1, pageVersion: null },
};
`;

    try {
      // Page 1: Published custom-domain article with ready 1200x630 <=300KiB OG image + hostile JSON-LD
      fs.writeFileSync(
        path.join(pagesDir, "article.astro"),
        `---
import Layout from ${JSON.stringify(layoutImport)};
import SEOHead from ${JSON.stringify(seoHeadImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";

${baseShellSnippet}
const metadata = generateOpenGraphMetadata({
  seo: {
    surface: "public_tenant",
    routeKind: "post",
    pathname: "/blog/artikel-uji",
    query: "?utm_source=whatsapp",
    tenant: {
      tenantHandle: "t016-alpha",
      tenantStatus: "active",
      primaryHost: "www.alphabrand.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["www.alphabrand.id", "t016-alpha.situsku.click"],
    },
  },
  tenantId: "${TENANT_ID_A}",
  siteName: "Alpha Brand",
  resourceTitle: 'Panduan "Aman" </title><script>alert(1)</script>',
  resourceExcerpt: "Ringkasan artikel untuk preview WhatsApp.",
  article: {
    publishedTime: "2026-10-15T09:00:00Z",
    modifiedTime: "2026-10-16T10:30:00Z",
  },
  resourceOgImage: {
    tenantId: "${TENANT_ID_A}",
    status: "ready",
    dbStatus: "ready",
    deletedAt: null,
    r2Key: "t/${TENANT_ID_A}/media/7/artikel-og.webp",
    url: "https://media.punyasitus.com/t/${TENANT_ID_A}/media/7/artikel-og.webp",
    width: 1200,
    height: 630,
    byteSize: 215000,
    mimeType: "image/webp",
    alt: 'Kartu "Artikel" Aman',
  },
});

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: '</script><script>window.__pwn=1</script>',
  url: metadata.canonical,
};
---
<Layout shell={baseShell} showConsent={false}>
  <SEOHead slot="head" metadata={metadata} jsonLd={jsonLd} />
  <h1>Artikel Uji</h1>
</Layout>
`,
      );

      // Page 2: Draft preview with oversized image (falls back to summary) -> noindex, nofollow, NO canonical, NO og:url
      fs.writeFileSync(
        path.join(pagesDir, "preview.astro"),
        `---
import Layout from ${JSON.stringify(layoutImport)};
import SEOHead from ${JSON.stringify(seoHeadImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";

${baseShellSnippet}
const previewShell = { ...baseShell, isPreview: true };
const metadata = generateOpenGraphMetadata({
  seo: {
    surface: "preview",
    routeKind: "preview",
    pathname: "/preview/page/9",
    tenant: {
      tenantHandle: "t016-alpha",
      tenantStatus: "active",
      primaryHost: "www.alphabrand.id",
      primaryHostKind: "custom",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
      verifiedTenantHosts: ["www.alphabrand.id"],
    },
  },
  tenantId: "${TENANT_ID_A}",
  siteName: "Alpha Brand",
  resourceTitle: "Pratinjau Draf",
  resourceOgImage: {
    tenantId: "${TENANT_ID_A}",
    status: "ready",
    url: "https://media.punyasitus.com/t/${TENANT_ID_A}/media/9/too-big-og.webp",
    width: 1200,
    height: 630,
    byteSize: 307201,
    mimeType: "image/webp",
  },
});
---
<Layout shell={previewShell} showConsent={false}>
  <SEOHead slot="head" metadata={metadata} />
  <h1>Pratinjau</h1>
</Layout>
`,
      );

      // Page 3: Trial site -> ALWAYS noindex, nofollow on verified subdomain
      fs.writeFileSync(
        path.join(pagesDir, "trial.astro"),
        `---
import Layout from ${JSON.stringify(layoutImport)};
import SEOHead from ${JSON.stringify(seoHeadImport)};
import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};
import { generateOpenGraphMetadata } from "@punyasitus/core/og-generator";

${baseShellSnippet}
const metadata = generateOpenGraphMetadata({
  seo: {
    surface: "public_tenant",
    routeKind: "homepage",
    pathname: "/",
    tenant: {
      tenantHandle: "t016-trial",
      tenantStatus: "trial",
      primaryHost: "t016-trial.situsku.click",
      primaryHostKind: "subdomain",
      primaryHostStatus: "active",
      primaryHostSslStatus: "active",
      primaryHostVerified: true,
    },
  },
  tenantId: "${TENANT_ID_A}",
  siteName: "Toko Trial",
});
---
<Layout shell={baseShell} showConsent={false}>
  <SEOHead slot="head" metadata={metadata} />
  <h1>Beranda Trial</h1>
</Layout>
`,
      );

      await astroMod.build({
        root: tmpRoot,
        srcDir,
        outDir,
        cacheDir,
        output: "static",
        logLevel: "silent",
      });

      const articleHtml = fs.readFileSync(path.join(outDir, "article/index.html"), "utf8");
      const previewHtml = fs.readFileSync(path.join(outDir, "preview/index.html"), "utf8");
      const trialHtml = fs.readFileSync(path.join(outDir, "trial/index.html"), "utf8");

      // Verify published custom-domain article head
      expect(articleHtml).toContain('<link rel="canonical" href="https://www.alphabrand.id/blog/artikel-uji" />');
      expect(articleHtml).toContain('<meta property="og:url" content="https://www.alphabrand.id/blog/artikel-uji" />');
      expect(articleHtml).toContain('<meta property="og:type" content="article" />');
      expect(articleHtml).toContain('<meta property="og:locale" content="id_ID" />');
      expect(articleHtml).toContain(
        `<meta property="og:image" content="https://media.punyasitus.com/t/${TENANT_ID_A}/media/7/artikel-og.webp" />`,
      );
      expect(articleHtml).toContain('<meta property="og:image:width" content="1200" />');
      expect(articleHtml).toContain('<meta property="og:image:height" content="630" />');
      expect(articleHtml).toContain('<meta property="og:image:type" content="image/webp" />');
      expect(articleHtml).toContain(
        '<meta property="article:published_time" content="2026-10-15T09:00:00.000Z" />',
      );
      expect(articleHtml).toContain(
        '<meta property="article:modified_time" content="2026-10-16T10:30:00.000Z" />',
      );
      expect(articleHtml).toContain('<meta name="twitter:card" content="summary_large_image" />');
      // Escaping assertions: zero raw script injection anywhere in title, attributes, or JSON-LD
      expect(articleHtml).not.toContain("<script>alert(1)</script>");
      expect(articleHtml).not.toContain("<script>window.__pwn=1</script>");
      expect(articleHtml).not.toContain("</title><script>");
      expect(articleHtml).toContain("\\u003c/script\\u003e");
      expect(articleHtml).toContain("&lt;/title&gt;&lt;script&gt;");

      // Verify draft preview head: noindex, nofollow + ZERO canonical + ZERO og:url + downgraded summary card
      expect(previewHtml).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(previewHtml).not.toContain('rel="canonical"');
      expect(previewHtml).not.toContain('property="og:url"');
      expect(previewHtml).not.toContain('property="og:image"');
      expect(previewHtml).toContain('<meta name="twitter:card" content="summary" />');

      // Verify trial site head: ALWAYS noindex, nofollow on verified subdomain
      expect(trialHtml).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(trialHtml).toContain('<link rel="canonical" href="https://t016-trial.situsku.click/" />');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps SEOHead.astro strictly isolated from admin CSS, @base-ui/react, and @radix-ui/*", () => {
    const seoHeadSource = fs.readFileSync(
      path.join(webDir, "src/components/SEOHead.astro"),
      "utf8",
    );
    expect(seoHeadSource).not.toContain("@radix-ui/");
    expect(seoHeadSource).not.toContain("@base-ui/react");
    expect(seoHeadSource).not.toContain("styles/admin");
    expect(seoHeadSource).not.toContain("components/ui");
  });
});
