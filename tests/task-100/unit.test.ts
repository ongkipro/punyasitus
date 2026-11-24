import { execSync } from "node:child_process";
import { RestrictedRichTextDocSchema } from "@punyasitus/core/schemas";
import { validatePluginMigrationSql } from "@punyasitus/core/plugins/index";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS,
  DEFAULT_PLUGIN_REGISTRY,
} from "../../apps/web/src/core/plugin-registry.ts";
import {
  WP_IMPORTER_MANIFEST,
  WP_IMPORTER_MIGRATIONS,
  WP_IMPORTER_PLUGIN,
  WP_IMPORTER_PLUGIN_ID,
  WP_IMPORTER_TABLE_PREFIX,
  WpImporterError,
  convertWpHtmlToSanitizedTipTapDoc,
  executeWpImport,
  fetchAndValidateExternalImage,
  guardWxrXmlPayload,
  guardedFetch,
  inspectWebpContainerSafety,
  parseWxrExport,
  processWpImageReference,
  validateSsrfUrl,
  type WpCreatedDraftPostResult,
  type WpImporterCmsWriterPort,
  type WpImporterFetchPort,
  type WpImporterMediaStoragePort,
  type WpImporterWebpEncoderPort,
} from "../../packages/plugins/wp-importer/index.ts";

function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Minimal valid 1x1 PNG binary (67 bytes, IHDR 1x1)
function createValidPngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, // 16x16
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0xf3, 0xff, 0x61, // bit depth + CRC
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, // IEND
  ]);
}

// Minimal valid VP8X WebP binary (30+ bytes, padded to exact target byte size if requested)
function createValidWebpBytes(width = 800, height = 600, totalBytes = 64): Uint8Array {
  const size = Math.max(30, totalBytes);
  const bytes = new Uint8Array(size);
  // RIFF header
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  const riffSize = size - 8;
  bytes[4] = riffSize & 0xff;
  bytes[5] = (riffSize >> 8) & 0xff;
  bytes[6] = (riffSize >> 16) & 0xff;
  bytes[7] = (riffSize >> 24) & 0xff;
  // WEBP + VP8X
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  // VP8X chunk size = 10
  bytes[16] = 10;
  // width-1 (24-bit LE) at offset 24, height-1 (24-bit LE) at offset 27
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  bytes[24] = wMinus1 & 0xff;
  bytes[25] = (wMinus1 >> 8) & 0xff;
  bytes[26] = (wMinus1 >> 16) & 0xff;
  bytes[27] = hMinus1 & 0xff;
  bytes[28] = (hMinus1 >> 8) & 0xff;
  bytes[29] = (hMinus1 >> 16) & 0xff;
  return bytes;
}

const GOLDEN_WXR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>Klinik Sehat Blog</title>
    <link>https://blog.kliniksehat.example.co.id</link>
    <wp:base_site_url>https://blog.kliniksehat.example.co.id</wp:base_site_url>
    <wp:base_blog_url>https://blog.kliniksehat.example.co.id</wp:base_blog_url>
    <wp:category>
      <wp:category_nicename>edukasi-kesehatan</wp:category_nicename>
      <wp:category_parent></wp:category_parent>
      <wp:cat_name><![CDATA[Edukasi Kesehatan]]></wp:cat_name>
      <wp:category_description><![CDATA[Tips kesehatan harian]]></wp:category_description>
    </wp:category>
    <wp:tag>
      <wp:tag_slug>gigi-anak</wp:tag_slug>
      <wp:tag_name><![CDATA[Gigi Anak]]></wp:tag_name>
    </wp:tag>
    <item>
      <title>Banner Klinik</title>
      <wp:post_id>501</wp:post_id>
      <wp:post_type>attachment</wp:post_type>
      <wp:attachment_url>https://cdn.kliniksehat.example.co.id/uploads/banner.png</wp:attachment_url>
      <wp:postmeta>
        <wp:meta_key>_wp_attachment_image_alt</wp:meta_key>
        <wp:meta_value><![CDATA[Foto pemeriksaan gigi anak]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title><![CDATA[Cara Merawat Gigi Anak Sejak Dini]]></title>
      <link>https://blog.kliniksehat.example.co.id/2026/05/cara-merawat-gigi-anak/</link>
      <wp:post_id>101</wp:post_id>
      <wp:post_name>cara-merawat-gigi-anak</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>post</wp:post_type>
      <category domain="category" nicename="edukasi-kesehatan"><![CDATA[Edukasi Kesehatan]]></category>
      <category domain="post_tag" nicename="gigi-anak"><![CDATA[Gigi Anak]]></category>
      <excerpt:encoded><![CDATA[Panduan praktis orang tua merawat gigi susu anak.]]></excerpt:encoded>
      <content:encoded><![CDATA[
        <!-- wp:heading -->
        <h2>Langkah Harian</h2>
        <!-- /wp:heading -->
        <p onclick="alert('xss')">Sikat gigi dua kali sehari dengan <a href="https://kliniksehat.example.co.id/layanan" onmouseover="evil()">pasta gigi berfluoride</a>.</p>
        <p><a href="javascript:alert(1)">Tautan Berbahaya</a></p>
        <script>window.__pwned = true;</script>
        <iframe src="https://evil.example/embed"></iframe>
        <ul><li>Pagi setelah sarapan</li><li>Malam sebelum tidur</li></ul>
        <blockquote>Konsultasi rutin setiap 6 bulan sekali.</blockquote>
        <img src="https://cdn.kliniksehat.example.co.id/uploads/inline-chart.png" alt="Grafik tumbuh gigi" onerror="alert(2)">
      ]]></content:encoded>
      <wp:postmeta>
        <wp:meta_key>_thumbnail_id</wp:meta_key>
        <wp:meta_value>501</wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_yoast_wpseo_title</wp:meta_key>
        <wp:meta_value><![CDATA[Cara Merawat Gigi Anak <script>bad()</script> | Klinik Sehat]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_yoast_wpseo_metadesc</wp:meta_key>
        <wp:meta_value><![CDATA[Panduan dokter gigi anak untuk menjaga kesehatan gigi susu sejak usia 1 tahun.]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Halaman Kontak Lama</title>
      <wp:post_id>202</wp:post_id>
      <wp:post_name>kontak</wp:post_name>
      <wp:status>publish</wp:status>
      <wp:post_type>page</wp:post_type>
      <content:encoded><![CDATA[<p>Bukan post blog</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

describe("TASK-100 Unit Tests — wp-importer Frozen-Core Boundary, SSRF, XXE, Media, Quota & Draft-Only", () => {
  it("keeps Frozen Core strictly untouched and registers wp-importer as opt-in public_free", () => {
    const statusOut = execSync("git status --porcelain", {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const touchedFiles = statusOut
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim().replace(/^"(.*)"$/, "$1"));

    const forbiddenPrefixes = [
      "packages/core/",
      "packages/db/",
      "packages/auth/",
      "apps/web/src/middleware/",
      "apps/web/src/pages/",
      "docs/api/openapi.json",
    ];

    for (const file of touchedFiles) {
      for (const prefix of forbiddenPrefixes) {
        expect(file.startsWith(prefix), `Frozen Core file unexpectedly modified: ${file}`).toBe(
          false,
        );
      }
    }

    expect(WP_IMPORTER_MANIFEST.id).toBe("wp-importer");
    expect(WP_IMPORTER_MANIFEST.visibility).toBe("public_free");
    expect(WP_IMPORTER_MANIFEST.priceIdr).toBe(0);
    expect(WP_IMPORTER_MANIFEST.tablePrefix).toBe("plg_wp_importer__");
    expect(WP_IMPORTER_MANIFEST.maxPublicJsBytes).toBe(0);

    // Statically registered in DEFAULT_PLUGIN_REGISTRY, NOT default-active on provision
    expect(DEFAULT_PLUGIN_REGISTRY.has(WP_IMPORTER_PLUGIN_ID)).toBe(true);
    expect(DEFAULT_PLUGIN_REGISTRY.get(WP_IMPORTER_PLUGIN_ID)?.manifest).toEqual(
      WP_IMPORTER_PLUGIN.manifest,
    );
    expect(
      (DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS as readonly string[]).includes(WP_IMPORTER_PLUGIN_ID),
    ).toBe(false);

    // Every migration SQL passes strict namespace validator (`plg_wp_importer__*`)
    for (const mig of WP_IMPORTER_MIGRATIONS) {
      const checked = validatePluginMigrationSql(WP_IMPORTER_PLUGIN_ID, mig.sql);
      expect(checked.tablePrefix).toBe(WP_IMPORTER_TABLE_PREFIX);
      expect(checked.touchedObjects.every((o) => o.startsWith(WP_IMPORTER_TABLE_PREFIX))).toBe(
        true,
      );
    }
  });

  describe("SSRF Guard Matrix (Base URL, Images & Redirect Hops)", () => {
    const blockedUrls = [
      "https://127.0.0.1/wp-json/wp/v2/posts",
      "https://127.255.255.254/img.jpg",
      "https://localhost/wp-json/wp/v2/posts",
      "https://api.localhost/wp-json",
      "https://printer.local/img.png",
      "https://db.internal/img.png",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.1/wp-json",
      "https://10.255.255.1/img.jpg",
      "https://172.16.0.1/wp-json",
      "https://172.31.255.254/img.jpg",
      "https://192.168.1.1/wp-json",
      "https://0.0.0.0/wp-json",
      "https://100.64.0.1/wp-json",
      "https://2130706433/wp-json", // decimal 127.0.0.1
      "https://0x7f000001/wp-json", // hex 127.0.0.1
      "https://0177.0.0.1/wp-json", // octal 127.0.0.1
      "https://127.1/wp-json", // shorthand 127.0.0.1
      "https://[::1]/wp-json",
      "https://[::]/wp-json",
      "https://[fc00::1]/wp-json",
      "https://[fd12:3456:789a::1]/wp-json",
      "https://[fe80::1]/wp-json",
      "https://[::ffff:127.0.0.1]/wp-json",
      "https://[::ffff:169.254.169.254]/latest/meta-data/",
      "https://[::ffff:7f00:1]/wp-json",
      "https://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "https://admin:secret@blog.example.co.id/wp-json",
      "https://blog.example.co.id:8080/wp-json",
      "https://metadata/latest/meta-data/",
      "https://127.0.0.1.nip.io/wp-json",
      "https://169.254.169.254.sslip.io/latest/meta-data/",
      "https://10.0.0.1.xip.io/wp-json",
      "https://admin.localtest.me/wp-json",
      "https://dev.lvh.me/wp-json",
      "http://blog.example.co.id/wp-json", // HTTP rejected by default
      "file:///etc/passwd",
      "ftp://blog.example.co.id/export.xml",
      "javascript:alert(1)",
    ];

    it.each(blockedUrls)("blocks SSRF target: %s", (badUrl) => {
      expect(() => validateSsrfUrl(badUrl)).toThrowError(WpImporterError);
      try {
        validateSsrfUrl(badUrl);
      } catch (err) {
        expect((err as WpImporterError).code).toBe("SSRF_BLOCKED");
      }
    });

    it("accepts legitimate public HTTPS WordPress URLs", () => {
      const ok = validateSsrfUrl("https://blog.nusantara.co.id/wp-json/wp/v2/posts");
      expect(ok.hostname).toBe("blog.nusantara.co.id");
    });

    it("blocks redirect from public host to cloud metadata 169.254.169.254 without fetching target", async () => {
      const calledUrls: string[] = [];
      const mockFetch: WpImporterFetchPort = async (input) => {
        const url = String(input);
        calledUrls.push(url);
        if (url === "https://public-wp.example.com/photo.jpg") {
          return new Response(null, {
            status: 302,
            headers: {
              Location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
            },
          });
        }
        throw new Error(`SHOULD NEVER FETCH PRIVATE REDIRECT TARGET: ${url}`);
      };

      await expect(
        guardedFetch("https://public-wp.example.com/photo.jpg", {
          fetchImpl: mockFetch,
          maxBytes: 1024 * 1024,
        }),
      ).rejects.toMatchObject({
        code: "SSRF_REDIRECT_BLOCKED",
      });

      expect(calledUrls).toEqual(["https://public-wp.example.com/photo.jpg"]);
    });
  });

  describe("WXR XML Bomb & XXE Guard", () => {
    it("rejects <!DOCTYPE / <!ENTITY XXE declarations", () => {
      const xxeXml = `<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<rss version="2.0"><channel><item><title>&xxe;</title></item></channel></rss>`;
      expect(() => guardWxrXmlPayload(xxeXml)).toThrowError(WpImporterError);
      try {
        guardWxrXmlPayload(xxeXml);
      } catch (err) {
        expect((err as WpImporterError).code).toBe("WXR_XXE_FORBIDDEN");
      }
    });

    it("rejects Billion Laughs entity expansion bomb", () => {
      const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<rss version="2.0"><channel><title>&lol2;</title></channel></rss>`;
      expect(() => parseWxrExport(billionLaughs)).toThrowError(WpImporterError);
    });

    it("rejects unknown custom entity references even without DOCTYPE", () => {
      const customEnt = `<?xml version="1.0"?><rss version="2.0"><channel><title>&evil_entity;</title></channel></rss>`;
      try {
        parseWxrExport(customEnt);
        expect.unreachable("should have rejected custom entity");
      } catch (err) {
        expect((err as WpImporterError).code).toBe("WXR_ENTITY_EXPANSION_FORBIDDEN");
      }
    });

    it("rejects oversized WXR payloads and malformed/unclosed CDATA", () => {
      const huge = `<rss><channel>${"a".repeat(2048)}</channel></rss>`;
      try {
        guardWxrXmlPayload(huge, { maxBytes: 512 });
        expect.unreachable("should reject oversized XML");
      } catch (err) {
        expect((err as WpImporterError).code).toBe("WXR_TOO_LARGE");
      }

      const unclosedCdata = `<rss><channel><item><title><![CDATA[broken</title></item></channel></rss>`;
      try {
        guardWxrXmlPayload(unclosedCdata);
        expect.unreachable("should reject unclosed CDATA");
      } catch (err) {
        expect((err as WpImporterError).code).toBe("WXR_MALFORMED");
      }
    });
  });

  describe("Media Magic-Byte Validation (Rejects SVG, HTML, PHP, Executables)", () => {
    const hostilePayloads: readonly { readonly name: string; readonly bytes: Uint8Array; readonly mime: string }[] = [
      {
        name: "SVG with image/svg+xml",
        bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
        mime: "image/svg+xml",
      },
      {
        name: "SVG spoofed as image/png",
        bytes: new TextEncoder().encode('<?xml version="1.0"?><svg><script>alert(1)</script></svg>'),
        mime: "image/png",
      },
      {
        name: "HTML script spoofed as image/jpeg",
        bytes: new TextEncoder().encode("<!doctype html><html><script>alert(1)</script></html>"),
        mime: "image/jpeg",
      },
      {
        name: "PHP webshell spoofed as image/jpeg",
        bytes: new TextEncoder().encode("<?php system($_GET['cmd']); ?>"),
        mime: "image/jpeg",
      },
      {
        name: "Windows PE executable (MZ) spoofed as image/png",
        bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]),
        mime: "image/png",
      },
      {
        name: "Linux ELF binary spoofed as image/webp",
        bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]),
        mime: "image/webp",
      },
    ];

    it.each(hostilePayloads)("rejects hostile media payload: $name", async ({ bytes, mime }) => {
      const mockFetch: WpImporterFetchPort = async () =>
        new Response(toBody(bytes), { status: 200, headers: { "Content-Type": mime } });

      await expect(
        fetchAndValidateExternalImage("https://cdn.example.co.id/uploads/photo.jpg", {
          fetchImpl: mockFetch,
        }),
      ).rejects.toMatchObject({
        code: "MEDIA_REJECTED",
      });
    });
  });

  describe("Golden /wp-json & WXR Imports -> Sanitized TipTap JSON Drafts + Storage Quota Enforcement", () => {
    it("imports golden /wp-json fixture strictly as DRAFT posts with sanitized TipTap JSON, SEO, former-URL inventory, and WebP images within quota", async () => {
      const pngBytes = createValidPngBytes();
      const webpOut = createValidWebpBytes(800, 600, 400);

      const mockFetch: WpImporterFetchPort = async (input) => {
        const url = String(input);
        if (url.includes("/wp-json/wp/v2/categories")) {
          return new Response(
            JSON.stringify([
              { id: 10, name: "Bisnis Digital", slug: "bisnis-digital", description: "Strategi UKM", parent: 0 },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/wp-json/wp/v2/tags")) {
          return new Response(
            JSON.stringify([{ id: 20, name: "SEO Lokal", slug: "seo-lokal" }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/wp-json/wp/v2/posts")) {
          return new Response(
            JSON.stringify([
              {
                id: 77,
                slug: "strategi-seo-toko-lokal",
                status: "publish", // Source is published -> MUST land as DRAFT!
                link: "https://blog.toko.example.co.id/2026/08/strategi-seo-toko-lokal/",
                title: { rendered: "Strategi SEO Toko Lokal 2026" },
                excerpt: { rendered: "<p>Ringkasan <strong>artikel</strong> SEO.</p>" },
                content: {
                  rendered: `
                    <!-- wp:heading --><h1>Judul Utama</h1><!-- /wp:heading -->
                    <p onclick="steal()">Konten aman dengan <a href="https://punyasitus.com/panduan">tautan valid</a>.</p>
                    <script>alert('xss')</script>
                    <iframe src="https://evil.test"></iframe>
                    <a href="javascript:alert(1)">Link jahat</a>
                    <ol><li>Langkah pertama</li><li>Langkah kedua</li></ol>
                    <blockquote>Kutipan ahli pemasaran.</blockquote>
                    <img src="https://cdn.toko.example.co.id/uploads/grafik.png" alt="Grafik kunjungan" onerror="alert(9)">
                    <img src="https://cdn.toko.example.co.id/uploads/evil.svg" alt="SVG jahat">
                    <img src="https://169.254.169.254/latest/meta-data/" alt="SSRF inline">
                  `,
                },
                categories: [10],
                tags: [20],
                yoast_head_json: {
                  title: "Strategi SEO Toko Lokal — Toko Contoh",
                  description: "Cara meningkatkan kunjungan organik toko lokal Indonesia.",
                },
                _embedded: {
                  "wp:featuredmedia": [
                    {
                      source_url: "https://cdn.toko.example.co.id/uploads/cover.png",
                      alt_text: "Cover strategi SEO",
                    },
                  ],
                },
              },
            ]),
            {
              status: 200,
              headers: { "Content-Type": "application/json", "X-WP-TotalPages": "1" },
            },
          );
        }
        if (url.endsWith("/cover.png") || url.endsWith("/grafik.png")) {
          return new Response(toBody(pngBytes), { status: 200, headers: { "Content-Type": "image/png" } });
        }
        if (url.endsWith("/evil.svg")) {
          return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          });
        }
        return new Response("Not Found", { status: 404 });
      };

      const webpEncoder: WpImporterWebpEncoderPort = async () => ({
        bytes: webpOut,
        width: 800,
        height: 600,
        mimeType: "image/webp",
      });

      // Quota allows ONLY ONE 400-byte image (500 bytes total available) -> 2nd valid image MUST fail safely!
      let usedBytes = 0;
      const quotaBytes = 500;
      let nextMediaId = 1;
      const storedR2Keys: string[] = [];

      const mediaPort: WpImporterMediaStoragePort = {
        async getQuotaSnapshot() {
          return {
            usedBytes,
            reservedBytes: 0,
            quotaBytes,
            availableBytes: Math.max(0, quotaBytes - usedBytes),
          };
        },
        async storeWebpAsset(asset) {
          if (usedBytes + asset.webpBytes.byteLength > quotaBytes) {
            return {
              ok: false,
              code: "STORAGE_QUOTA_EXCEEDED",
              message: "Quota exceeded",
            };
          }
          const mediaId = nextMediaId++;
          const r2Key = `t/${asset.tenantId}/media/${mediaId}/${asset.filename}`;
          usedBytes += asset.webpBytes.byteLength;
          storedR2Keys.push(r2Key);
          return { ok: true, mediaId, r2Key, bytes: asset.webpBytes.byteLength };
        },
      };

      const createdDrafts: WpCreatedDraftPostResult[] = [];
      const createdCategories: string[] = [];
      const createdTags: string[] = [];
      const cmsWriter: WpImporterCmsWriterPort = {
        async ensureCategory(c) {
          createdCategories.push(c.slug);
          return { id: 1, slug: c.slug, created: true };
        },
        async ensureTag(t) {
          createdTags.push(t.slug);
          return { id: 2, slug: t.slug, created: true };
        },
        async createDraftPost(p) {
          expect(p.status).toBe("draft");
          // Validate TipTap JSON against canonical RestrictedRichTextDocSchema
          expect(() => RestrictedRichTextDocSchema.parse(p.body)).not.toThrow();
          const res: WpCreatedDraftPostResult = {
            id: 100 + createdDrafts.length,
            slug: p.slug,
            status: "draft",
            publishedAt: null,
          };
          createdDrafts.push(res);
          return res;
        },
      };

      const tenant = {
        id: "01JT100UNIT000000000000001",
        handle: "toko-contoh",
        name: "Toko Contoh",
        status: "active",
      };

      // 1. Dry-run MUST NOT mutate CMS or R2
      const dryReport = await executeWpImport(
        {
          mode: "dry_run",
          sourceKind: "wp_json",
          siteUrl: "https://blog.toko.example.co.id",
          importImages: true,
        },
        { tenant, actorUserId: "user_1", fetchImpl: mockFetch, webpEncoder, mediaPort, cmsWriter },
      );
      expect(dryReport.mode).toBe("dry_run");
      expect(dryReport.draftOnlyEnforced).toBe(true);
      expect(dryReport.counts.postsFound).toBe(1);
      expect(dryReport.counts.postsImported).toBe(0);
      expect(createdDrafts.length).toBe(0);
      expect(storedR2Keys.length).toBe(0);

      // 2. Execute import
      const report = await executeWpImport(
        {
          mode: "import",
          sourceKind: "wp_json",
          siteUrl: "https://blog.toko.example.co.id",
          importImages: true,
        },
        { tenant, actorUserId: "user_1", fetchImpl: mockFetch, webpEncoder, mediaPort, cmsWriter },
      );

      expect(report.mode).toBe("import");
      expect(report.draftOnlyEnforced).toBe(true);
      expect(report.counts.postsImported).toBe(1);
      expect(report.posts[0]!.sourceStatus).toBe("publish");
      expect(report.posts[0]!.importedStatus).toBe("draft");
      expect(report.posts[0]!.publishedAt).toBeNull();
      expect(createdDrafts[0]!.status).toBe("draft");
      expect(createdDrafts[0]!.publishedAt).toBeNull();

      // Categories, tags & SEO metadata imported
      expect(createdCategories).toEqual(["bisnis-digital"]);
      expect(createdTags).toEqual(["seo-lokal"]);
      expect(report.posts[0]!.sanitizedSeo?.titleOverride).toContain("Strategi SEO Toko Lokal");

      // TipTap JSON sanitization: zero script/iframe/javascript:/on*, preserved headings/lists/blockquote/link
      const serializedBody = JSON.stringify(report.posts[0]!.sanitizedBody);
      expect(serializedBody).not.toContain("<script");
      expect(serializedBody).not.toContain("<iframe");
      expect(serializedBody).not.toContain("javascript:");
      expect(serializedBody).not.toContain("onclick");
      expect(serializedBody).not.toContain("onerror");
      expect(report.posts[0]!.sanitizedBody.blocks.some((b) => b.type === "heading" && b.level === 2)).toBe(true);
      expect(report.posts[0]!.sanitizedBody.blocks.some((b) => b.type === "orderedList")).toBe(true);
      expect(report.posts[0]!.sanitizedBody.blocks.some((b) => b.type === "blockquote")).toBe(true);

      // Quota enforcement + SVG & SSRF inline image blocking
      expect(report.counts.imagesImported).toBe(1); // Cover fits in 500B quota
      expect(report.quota.exceeded).toBe(true); // 2nd valid PNG refused without exceeding quota!
      expect(usedBytes).toBeLessThanOrEqual(quotaBytes);
      expect(usedBytes).toBe(400);
      expect(storedR2Keys).toHaveLength(1);
      expect(storedR2Keys[0]).toMatch(/^t\/01JT100UNIT000000000000001\/media\/1\/.*\.webp$/);
      expect(report.media.some((m) => m.sourceUrl.includes("evil.svg") && m.status === "rejected")).toBe(true);
      expect(
        report.media.some(
          (m) => m.sourceUrl.includes("169.254.169.254") && m.status === "rejected" && m.reasonCode === "SSRF_BLOCKED",
        ),
      ).toBe(true);
      expect(report.media.some((m) => m.status === "quota_exceeded")).toBe(true);

      // Former-URL inventory
      expect(report.formerUrls).toHaveLength(1);
      expect(report.formerUrls[0]).toMatchObject({
        sourcePath: "/2026/08/strategi-seo-toko-lokal/",
        targetSlug: "strategi-seo-toko-lokal",
        targetPath: "/blog/strategi-seo-toko-lokal",
        sourceStatus: "publish",
        importedStatus: "draft",
      });
    });

    it("parses golden WXR XML fixture into sanitized TipTap JSON drafts, skipping non-post items and stripping scripts", async () => {
      const pngBytes = createValidPngBytes();
      const webpBytes = createValidWebpBytes(640, 480, 320);
      const mockFetch: WpImporterFetchPort = async () =>
        new Response(toBody(pngBytes), { status: 200, headers: { "Content-Type": "image/png" } });
      const webpEncoder: WpImporterWebpEncoderPort = async () => ({
        bytes: webpBytes,
        width: 640,
        height: 480,
        mimeType: "image/webp",
      });

      const report = await executeWpImport(
        {
          mode: "dry_run",
          sourceKind: "wxr",
          wxrXml: GOLDEN_WXR_XML,
          importImages: true,
        },
        {
          tenant: {
            id: "01JT100WXR0000000000000002",
            handle: "klinik-sehat",
            name: "Klinik Sehat",
            status: "active",
          },
          actorUserId: "user_wxr",
          fetchImpl: mockFetch,
          webpEncoder,
        },
      );

      expect(report.counts.postsFound).toBe(1);
      expect(report.counts.postsSkipped).toBe(1); // <wp:post_type>page</wp:post_type> skipped
      expect(report.counts.categoriesFound).toBe(1);
      expect(report.counts.tagsFound).toBe(1);
      expect(report.counts.imagesFound).toBe(2); // featured _thumbnail_id + inline img
      expect(report.posts[0]!.importedStatus).toBe("draft");
      expect(report.posts[0]!.publishedAt).toBeNull();
      expect(report.posts[0]!.sanitizedSeo?.titleOverride).not.toContain("<script");
      expect(report.posts[0]!.sanitizedSeo?.titleOverride).toContain("Cara Merawat Gigi Anak");

      const bodyJson = JSON.stringify(report.posts[0]!.sanitizedBody);
      expect(bodyJson).not.toContain("window.__pwned");
      expect(bodyJson).not.toContain("<iframe");
      expect(bodyJson).not.toContain("javascript:");
      expect(report.formerUrls[0]!.sourcePath).toBe("/2026/05/cara-merawat-gigi-anak/");
      expect(report.formerUrls[0]!.targetPath).toBe("/blog/cara-merawat-gigi-anak");
    });

    it("rewrites imported inline image URLs to TipTap image blocks with tenant mediaId", () => {
      const map = new Map<string, number>([
        ["https://cdn.example.co.id/photo.png", 42],
      ]);
      const { doc } = convertWpHtmlToSanitizedTipTapDoc(
        `<p>Intro</p><img src="https://cdn.example.co.id/photo.png" alt="Foto Produk"><img src="https://unimported.example.co.id/x.png" alt="Dropped">`,
        { mediaIdBySourceUrl: map },
      );
      expect(doc.blocks.some((b) => b.type === "image" && b.mediaId === 42 && b.text === "Foto Produk")).toBe(true);
      expect(JSON.stringify(doc)).not.toContain("unimported.example.co.id");
    });

    it("strips nested smuggling tags (<scr<script>ipt>) via fixed-point preprocessing", () => {
      const { doc, sanitizedHtml } = convertWpHtmlToSanitizedTipTapDoc(
        `<p>Aman</p><scr<script>ipt>alert(1)</script><p>Selesai</p>`,
      );
      expect(sanitizedHtml).not.toContain("<script");
      expect(JSON.stringify(doc)).not.toContain("alert(1)");
      expect(doc.blocks.some((b) => b.text === "Aman")).toBe(true);
    });

    it("fails closed with 503 CMS_WRITER_UNAVAILABLE in import mode when no CMS writer is bound", async () => {
      await expect(
        executeWpImport(
          {
            mode: "import",
            sourceKind: "wxr",
            wxrXml: GOLDEN_WXR_XML,
            importImages: false,
          },
          {
            tenant: {
              id: "01JT100NOCMS00000000000003",
              handle: "no-cms",
              name: "No CMS",
              status: "active",
            },
            actorUserId: "user_1",
          },
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: "CMS_WRITER_UNAVAILABLE",
      });
    });

    it("rejects WebP with EXIF/XMP chunks or trailing polyglot bytes when no encoder is available, and allows clean stripped WebP", async () => {
      // 1. Clean WebP (VP8X flags = 0, exact RIFF length = 30)
      const cleanWebp = createValidWebpBytes(800, 600, 30);
      expect(inspectWebpContainerSafety(cleanWebp).ok).toBe(true);

      // 2. WebP with trailing polyglot bytes after RIFF container
      const polyglotTrailer = new TextEncoder().encode("<script>alert(1)</script>");
      const webpWithTrailer = new Uint8Array(cleanWebp.byteLength + polyglotTrailer.byteLength);
      webpWithTrailer.set(cleanWebp, 0);
      webpWithTrailer.set(polyglotTrailer, cleanWebp.byteLength);
      expect(inspectWebpContainerSafety(webpWithTrailer).ok).toBe(false);

      // 3. WebP with EXIF chunk inside RIFF
      const exifPayload = new TextEncoder().encode("Exif\0\0MM");
      const totalWithExif = 30 + 8 + exifPayload.byteLength;
      const webpWithExif = new Uint8Array(totalWithExif);
      webpWithExif.set(cleanWebp, 0);
      const newRiffSize = totalWithExif - 8;
      webpWithExif[4] = newRiffSize & 0xff;
      webpWithExif[5] = (newRiffSize >> 8) & 0xff;
      webpWithExif[6] = (newRiffSize >> 16) & 0xff;
      webpWithExif[7] = (newRiffSize >> 24) & 0xff;
      // EXIF chunk at offset 30
      webpWithExif.set([0x45, 0x58, 0x49, 0x46], 30); // "EXIF"
      webpWithExif[34] = exifPayload.byteLength & 0xff;
      webpWithExif.set(exifPayload, 38);
      expect(inspectWebpContainerSafety(webpWithExif).ok).toBe(false);

      // Verify processWpImageReference rejects both when no encoder is provided
      for (const badBytes of [webpWithTrailer, webpWithExif]) {
        const res = await processWpImageReference({
          tenantId: "01JT100WEBP000000000000004",
          sourceUrl: "https://cdn.example.co.id/photo.webp",
          altText: "Test",
          mode: "import",
          fetchImpl: async () =>
            new Response(toBody(badBytes), {
              status: 200,
              headers: { "Content-Type": "image/webp" },
            }),
          remainingQuotaBytes: 1_000_000,
          nowMs: Date.now(),
        });
        expect(res.reportItem.status).toBe("rejected");
        expect(res.reportItem.reasonCode).toBe("MEDIA_REJECTED");
      }
    });

    it("scans large WXR XML without CDATA in linear O(n) time", () => {
      const itemChunk = `<item><title>Post</title><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:post_name>post</wp:post_name><content:encoded>Paragraf pendek tanpa CDATA</content:encoded></item>`;
      const padding = "x".repeat(500_000);
      const bigWxr = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><link>https://blog.example.co.id</link><description>${padding}</description>${itemChunk.repeat(200)}</channel></rss>`;

      const start = performance.now();
      const parsed = parseWxrExport(bigWxr, { maxPosts: 50 });
      const elapsedMs = performance.now() - start;

      expect(parsed.posts).toHaveLength(50);
      expect(elapsedMs).toBeLessThan(1500);
    });
  });
});
