import { describe, expect, it } from "vitest";
import {
  buildBlogRssFeedXml,
  buildSitemapIndexXml,
  buildSubSitemapPath,
  buildUrlsetXml,
  chunkSitemapUrlEntries,
  formatIsoLastmod,
  formatRfc2822Date,
  handleBlogFeedRequest,
  handleRobotsTxtRequest,
  handleSitemapIndexRequest,
  handleSubSitemapRequest,
  MAX_RSS_FEED_ITEMS,
  parseInlineSectionImageUrl,
  parseSubSitemapParam,
  validateInlineSectionImageUrl,
  type SitemapUrlEntry,
} from "../../apps/web/src/pages/sitemaps/_shared.ts";
import { getChildElements, getFirstChildText, parseStrictXml } from "./xml-parser.ts";

describe("TASK-017: Sitemap, Robots & RSS Feed Pure Builders and Guards (Unit)", () => {
  it("builds strict, XML-escaped sitemap index and urlset with Google Image namespace", () => {
    const indexXml = buildSitemapIndexXml([
      {
        loc: "https://www.toko-maju.id/sitemaps/pages.xml",
        lastmod: "2026-11-20T08:00:00.000Z",
      },
      // Duplicate loc must be deduplicated cleanly
      {
        loc: "https://www.toko-maju.id/sitemaps/pages.xml",
        lastmod: "2026-11-21T08:00:00.000Z",
      },
      {
        loc: "https://www.toko-maju.id/sitemaps/posts.xml",
        lastmod: "2026-11-22T10:30:00.000Z",
      },
    ]);

    const indexRoot = parseStrictXml(indexXml);
    expect(indexRoot.name).toBe("sitemapindex");
    expect(indexRoot.attributes.xmlns).toBe("http://www.sitemaps.org/schemas/sitemap/0.9");
    const sitemaps = getChildElements(indexRoot, "sitemap");
    expect(sitemaps).toHaveLength(2);
    expect(getFirstChildText(sitemaps[0]!, "loc")).toBe(
      "https://www.toko-maju.id/sitemaps/pages.xml",
    );
    expect(getFirstChildText(sitemaps[0]!, "lastmod")).toBe("2026-11-20T08:00:00.000Z");

    const urlsetXml = buildUrlsetXml([
      {
        loc: "https://www.toko-maju.id/",
        lastmod: "2026-11-20T08:00:00.000Z",
        images: [
          {
            loc: "https://media.punyasitus.com/t/01JT017/media/1/hero-banner-w1280.webp",
            title: 'Katalog <B2B> & "Promo" \'2026\'\u0007',
          },
          // Duplicate image loc must be deduplicated
          {
            loc: "https://media.punyasitus.com/t/01JT017/media/1/hero-banner-w1280.webp",
            title: "Duplicate",
          },
        ],
      },
      // Duplicate URL entry must be deduplicated
      {
        loc: "https://www.toko-maju.id/",
        lastmod: "2026-11-22T00:00:00.000Z",
      },
    ]);

    const urlRoot = parseStrictXml(urlsetXml);
    expect(urlRoot.name).toBe("urlset");
    expect(urlRoot.attributes["xmlns:image"]).toBe(
      "http://www.google.com/schemas/sitemap-image/1.1",
    );
    const urls = getChildElements(urlRoot, "url");
    expect(urls).toHaveLength(1);
    expect(getFirstChildText(urls[0]!, "loc")).toBe("https://www.toko-maju.id/");
    const imgs = getChildElements(urls[0]!, "image:image");
    expect(imgs).toHaveLength(1);
    expect(getFirstChildText(imgs[0]!, "image:loc")).toBe(
      "https://media.punyasitus.com/t/01JT017/media/1/hero-banner-w1280.webp",
    );
    expect(getFirstChildText(imgs[0]!, "image:title")).toBe('Katalog <B2B> & "Promo" \'2026\'');
  });

  it("chunks sitemap entries strictly by maxUrls and maxBytes with deduplication", () => {
    const entries: SitemapUrlEntry[] = Array.from({ length: 7 }, (_, i) => ({
      loc: `https://www.toko-maju.id/blog/artikel-${i + 1}`,
      lastmod: "2026-11-20T00:00:00.000Z",
    }));
    // Add a duplicate entry to confirm dedup happens before chunking
    entries.push({
      loc: "https://www.toko-maju.id/blog/artikel-1",
      lastmod: "2026-11-20T00:00:00.000Z",
    });

    const byCount = chunkSitemapUrlEntries(entries, { maxUrls: 3 });
    expect(byCount).toHaveLength(3);
    expect(byCount[0]).toHaveLength(3);
    expect(byCount[1]).toHaveLength(3);
    expect(byCount[2]).toHaveLength(1);

    const byBytes = chunkSitemapUrlEntries(entries, { maxUrls: 100, maxBytes: 512 });
    expect(byBytes.length).toBeGreaterThan(1);
    for (const chunk of byBytes) {
      const xml = buildUrlsetXml(chunk);
      expect(() => parseStrictXml(xml)).not.toThrow();
    }
  });

  it("validates sub-sitemap route parameters and rejects invalid or traversal inputs", () => {
    expect(parseSubSitemapParam("pages")).toEqual({ kind: "pages", chunkIndex: 1 });
    expect(parseSubSitemapParam("posts.xml")).toEqual({ kind: "posts", chunkIndex: 1 });
    expect(parseSubSitemapParam("offerings-2")).toEqual({ kind: "offerings", chunkIndex: 2 });
    expect(parseSubSitemapParam("pages-1")).toBeNull(); // Chunk 1 must be `pages.xml`
    expect(parseSubSitemapParam("pages-0")).toBeNull();
    expect(parseSubSitemapParam("../secret")).toBeNull();
    expect(parseSubSitemapParam("users")).toBeNull();
    expect(parseSubSitemapParam(undefined)).toBeNull();

    expect(buildSubSitemapPath("pages", 1)).toBe("/sitemaps/pages.xml");
    expect(buildSubSitemapPath("pages", 2)).toBe("/sitemaps/pages-2.xml");
  });

  it("builds strict RSS 2.0 XML capped at 20 items with XML escaping and RFC-2822 dates", () => {
    const items = Array.from({ length: 25 }, (_, idx) => ({
      title: `Artikel #${idx + 1} <Special & "Quoted">`,
      link: `https://www.toko-maju.id/blog/artikel-${idx + 1}`,
      guid: `https://www.toko-maju.id/blog/artikel-${idx + 1}`,
      pubDate: formatRfc2822Date(1_830_000_000_000 - idx * 60_000)!,
      description: `Ringkasan & detail untuk <artikel> #${idx + 1}`,
      image:
        idx === 0
          ? {
              url: "https://media.punyasitus.com/t/01JT017/media/1/cover-w1280.webp",
              bytes: 48_000,
              mimeType: "image/webp",
              title: "Cover & Banner",
            }
          : null,
    }));

    const rssXml = buildBlogRssFeedXml(
      {
        title: 'Toko Maju & "Mitra"',
        link: "https://www.toko-maju.id/blog",
        feedUrl: "https://www.toko-maju.id/blog/feed.xml",
        description: "Update industri & tips bisnis",
        language: "id-ID",
        lastBuildDate: formatRfc2822Date(1_830_000_000_000),
      },
      items,
    );

    const root = parseStrictXml(rssXml);
    expect(root.name).toBe("rss");
    expect(root.attributes.version).toBe("2.0");
    const channel = getChildElements(root, "channel")[0]!;
    expect(getFirstChildText(channel, "title")).toBe('Toko Maju & "Mitra"');
    expect(getFirstChildText(channel, "link")).toBe("https://www.toko-maju.id/blog");

    const parsedItems = getChildElements(channel, "item");
    expect(parsedItems).toHaveLength(MAX_RSS_FEED_ITEMS);
    expect(getFirstChildText(parsedItems[0]!, "title")).toBe('Artikel #1 <Special & "Quoted">');
    expect(getFirstChildText(parsedItems[0]!, "pubDate")).toMatch(/GMT$/);
    const enclosures = getChildElements(parsedItems[0]!, "enclosure");
    expect(enclosures).toHaveLength(1);
    expect(enclosures[0]!.attributes.url).toBe(
      "https://media.punyasitus.com/t/01JT017/media/1/cover-w1280.webp",
    );
    expect(enclosures[0]!.attributes.type).toBe("image/webp");
  });

  it("formats ISO lastmod and RFC-2822 dates safely and rejects invalid timestamps", () => {
    expect(formatIsoLastmod(1_830_000_000_000)).toBe(new Date(1_830_000_000_000).toISOString());
    expect(formatIsoLastmod(0)).toBeNull();
    expect(formatIsoLastmod(-100)).toBeNull();
    expect(formatIsoLastmod(null)).toBeNull();
    expect(formatRfc2822Date(1_830_000_000_000)).toBe(new Date(1_830_000_000_000).toUTCString());
    expect(formatRfc2822Date(undefined)).toBeNull();
  });

  it("blocks unknown hosts and platform app/console hosts safely without leaking any tenant sitemap", async () => {
    const unknownSitemap = await handleSitemapIndexRequest(
      new Request("https://unknown-host.example.com/sitemap.xml"),
      {},
    );
    expect(unknownSitemap.status).toBe(404);
    expect(unknownSitemap.headers.get("cache-control")).toBe("no-store");
    expect(unknownSitemap.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const unknownRobots = await handleRobotsTxtRequest(
      new Request("https://unknown-host.example.com/robots.txt"),
      {},
    );
    expect(unknownRobots.status).toBe(404);
    const unknownRobotsBody = await unknownRobots.text();
    expect(unknownRobotsBody).toContain("Disallow: /");
    expect(unknownRobotsBody).not.toContain("Sitemap:");

    const appRobots = await handleRobotsTxtRequest(
      new Request("https://app.punyasitus.com/robots.txt"),
      {},
    );
    expect(appRobots.status).toBe(200);
    expect(appRobots.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const appRobotsBody = await appRobots.text();
    expect(appRobotsBody).toContain("Disallow: /");
    expect(appRobotsBody).not.toContain("Sitemap:");

    const consoleSitemap = await handleSitemapIndexRequest(
      new Request("https://console.punyasitus.com/sitemap.xml"),
      {},
    );
    expect(consoleSitemap.status).toBe(404);

    const appFeed = await handleBlogFeedRequest(
      new Request("https://app.punyasitus.com/blog/feed.xml"),
      {},
    );
    expect(appFeed.status).toBe(404);

    const invalidSub = await handleSubSitemapRequest(
      new Request("https://unknown-host.example.com/sitemaps/secret.xml"),
      "secret",
      {},
    );
    expect(invalidSub.status).toBe(404);
  });

  it("strictly validates inline section image URLs against tenant media CDN namespace and rejects bypasses", () => {
    const tenantId = "01JT017ALPHA00000000000001";
    const otherTenantId = "01JT017BETA000000000000002";

    // Valid own-tenant media CDN URL
    const valid = parseInlineSectionImageUrl(
      `https://media.punyasitus.com/t/${tenantId}/media/12/gedung-utama-w1280.webp`,
      tenantId,
    );
    expect(valid).toEqual({
      url: `https://media.punyasitus.com/t/${tenantId}/media/12/gedung-utama-w1280.webp`,
      r2Key: `t/${tenantId}/media/12/gedung-utama-w1280.webp`,
      mediaId: 12,
    });

    // Rejects media CDN URL with no `/t/` prefix
    expect(
      validateInlineSectionImageUrl("https://media.punyasitus.com/raw-image.webp", tenantId),
    ).toBeNull();

    // Rejects percent-encoded foreign tenant bypass (`/%74/...`)
    expect(
      validateInlineSectionImageUrl(
        `https://media.punyasitus.com/%74/${otherTenantId}/media/1/x.webp`,
        tenantId,
      ),
    ).toBeNull();

    // Rejects direct foreign tenant path
    expect(
      validateInlineSectionImageUrl(
        `https://media.punyasitus.com/t/${otherTenantId}/media/1/x.webp`,
        tenantId,
      ),
    ).toBeNull();

    // Rejects own-tenant quarantine/trash paths, traversal, query/fragment, non-CDN origin, credentials, ports
    expect(
      validateInlineSectionImageUrl(
        `https://media.punyasitus.com/t/${tenantId}/quarantine/1/x.webp`,
        tenantId,
      ),
    ).toBeNull();
    expect(
      validateInlineSectionImageUrl(
        `https://media.punyasitus.com/t/${tenantId}/media/1/x.webp?v=1`,
        tenantId,
      ),
    ).toBeNull();
    expect(
      validateInlineSectionImageUrl(
        `https://media.punyasitus.com/t/${tenantId}/media/../other/x.webp`,
        tenantId,
      ),
    ).toBeNull();
    expect(
      validateInlineSectionImageUrl(
        `https://www.t017-alpha.id/t/${tenantId}/media/1/x.webp`,
        tenantId,
      ),
    ).toBeNull();
    expect(
      validateInlineSectionImageUrl(
        `https://user:pass@media.punyasitus.com/t/${tenantId}/media/1/x.webp`,
        tenantId,
      ),
    ).toBeNull();
    expect(
      validateInlineSectionImageUrl(
        `https://media.punyasitus.com:8443/t/${tenantId}/media/1/x.webp`,
        tenantId,
      ),
    ).toBeNull();
  });
});
