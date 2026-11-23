import fs from "node:fs";
import path from "node:path";
import {
  buildAuthorBylineAndSchemaParity,
  calculateLinearReadingTimeMinutes,
  computeSubstantivePostFingerprint,
  countWordsLinear,
  decodeHtmlEntitiesLinear,
  estimatePostReadingTime,
  extractAndInjectServerToc,
  extractTocFromRichTextDoc,
  hasSubstantivePublishedPostChange,
  resolvePublishedContentModifiedAt,
  shouldRenderServerToc,
  slugifyTocHeadingText,
  stripHtmlToPlainTextLinear,
  validateAuthorProfilePayload,
  validateBlogCategoryDepth,
  type SubstantivePostContentInput,
} from "@punyasitus/core/posts/index";
import {
  BLOG_AUTHOR_TOC_MODIFIED_MIGRATION,
  BLOG_AUTHOR_TOC_MODIFIED_MIGRATION_SQL,
} from "@punyasitus/db/posts/migrations";
import { describe, expect, it } from "vitest";
import { synchronizeBlogSchemaGraphAuthorAndDates } from "../../apps/web/src/pages/blog/_post-detail-helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-092 unit tests — migration parity, reading time, linear O(n) TOC, content_modified_at & category depth", () => {
  it("keeps 0020_blog_author_toc_modified SQL bundle byte-for-byte identical to disk", () => {
    const onDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0020_blog_author_toc_modified.sql"),
      "utf8",
    );
    expect(BLOG_AUTHOR_TOC_MODIFIED_MIGRATION.version).toBe(20);
    expect(BLOG_AUTHOR_TOC_MODIFIED_MIGRATION.name).toBe("0020_blog_author_toc_modified");
    expect(BLOG_AUTHOR_TOC_MODIFIED_MIGRATION_SQL).toBe(onDisk);
    expect(onDisk).toContain("ALTER TABLE authors ADD COLUMN role_title TEXT;");
    expect(onDisk).toContain("ALTER TABLE posts ADD COLUMN content_fingerprint TEXT;");
  });

  describe("Linear O(n) HTML stripping & deterministic reading-time estimator", () => {
    it("strips HTML tags, entities, and script/style blocks safely and enforces min 1 minute at 200 wpm", () => {
      expect(calculateLinearReadingTimeMinutes("")).toBe(1);
      expect(calculateLinearReadingTimeMinutes("<p>Halo dunia</p>")).toBe(1);

      const words201 = Array.from({ length: 201 }, (_, i) => `kata${i}`).join(" ");
      const estimate = estimatePostReadingTime(
        `<p>${words201}</p><script>alert("ignored script words should not count")</script><style>.x{color:red}</style>`,
      );
      expect(estimate.wordCount).toBe(201);
      expect(estimate.wordsPerMinute).toBe(200);
      expect(estimate.readingTimeMinutes).toBe(2);

      expect(
        stripHtmlToPlainTextLinear(
          `<h2>Biaya &amp; Jadwal Renovasi &mdash; Tahap 1</h2><p>Harga Rp 50.000 &lt; Rp 100.000</p>`,
        ),
      ).toBe("Biaya & Jadwal Renovasi — Tahap 1 Harga Rp 50.000 < Rp 100.000");

      expect(
        countWordsLinear({
          schemaVersion: 1,
          blocks: [
            { type: "heading", level: 2, text: "Panduan Renovasi Kantor" },
            { type: "paragraph", text: "Empat kata sangat jelas" },
            { type: "listItem", text: "Item satu dan dua" },
          ],
        }),
      ).toBe(11);
    });

    it("executes in strict linear O(n) time on 100 KiB pathological unclosed tags and 50k ampersands (zero ReDoS / zero O(n^2))", () => {
      const pathological = "<a ".repeat(35_000) + "kata akhir";
      const start = performance.now();
      const plain = stripHtmlToPlainTextLinear(pathological);
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(200);
      expect(typeof plain).toBe("string");

      const amps = "&".repeat(50_000);
      const ampStart = performance.now();
      const decodedAmps = decodeHtmlEntitiesLinear(amps);
      const ampElapsedMs = performance.now() - ampStart;
      expect(ampElapsedMs).toBeLessThan(200);
      expect(decodedAmps.length).toBe(50_000);
    });
  });

  describe("Linear O(n) server-rendered H2/H3 TOC extraction & anchor injection", () => {
    it("extracts H2/H3 headings, handles Indonesian punctuation & duplicates (-2, -3), and prevents collisions", () => {
      const html = [
        "<h2>Persiapan &amp; Audit Café 2026!</h2>",
        "<p>Paragraf pembuka.</p>",
        "<h3>Langkah <strong>Pertama</strong></h3>",
        "<h3>Langkah Pertama</h3>",
        "<h3>Langkah Pertama 2</h3>",
        "<h4>Heading H4 diabaikan</h4>",
        "<h2>   </h2>",
        "<h2>???</h2>",
        '<h2 id="old-id" onclick="alert(1)" style="color:red" class="lead">Penutup</h2>',
      ].join("\n");

      const res = extractAndInjectServerToc(html);
      expect(res.headingCount).toBe(6);
      expect(res.toc).toEqual([
        { id: "persiapan-audit-cafe-2026", text: "Persiapan & Audit Café 2026!", level: 2 },
        { id: "langkah-pertama", text: "Langkah Pertama", level: 3 },
        { id: "langkah-pertama-2", text: "Langkah Pertama", level: 3 },
        { id: "langkah-pertama-2-2", text: "Langkah Pertama 2", level: 3 },
        { id: "section-5", text: "???", level: 2 },
        { id: "penutup", text: "Penutup", level: 2 },
      ]);

      // All anchor IDs are unique and injected into rendered HTML
      const ids = res.toc.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const entry of res.toc) {
        expect(res.html).toContain(`id="${entry.id}"`);
      }

      // Strips dangerous inline event handlers & old IDs while preserving safe class
      expect(res.html).not.toContain("onclick=");
      expect(res.html).not.toContain('id="old-id"');
      expect(res.html).not.toContain("style=");
      expect(res.html).toContain('<h2 class="lead" id="penutup">Penutup</h2>');
      // H4 stays untouched and excluded from TOC
      expect(res.html).toContain("<h4>Heading H4 diabaikan</h4>");
    });

    it("keeps extractTocFromRichTextDoc IDs 1:1 consistent with extractAndInjectServerToc", () => {
      const doc = {
        schemaVersion: 1 as const,
        blocks: [
          { type: "heading" as const, level: 2 as const, text: "Pendahuluan & Ruang Lingkup" },
          { type: "paragraph" as const, text: "Isi paragraf." },
          { type: "heading" as const, level: 3 as const, text: "Estimasi Biaya" },
          { type: "heading" as const, level: 3 as const, text: "Estimasi Biaya" },
        ],
      };
      const docToc = extractTocFromRichTextDoc(doc);
      const htmlToc = extractAndInjectServerToc(
        "<h2>Pendahuluan &amp; Ruang Lingkup</h2><p>Isi paragraf.</p><h3>Estimasi Biaya</h3><h3>Estimasi Biaya</h3>",
      ).toc;
      expect(docToc).toEqual(htmlToc);
      expect(shouldRenderServerToc(true, docToc)).toBe(true);
      expect(shouldRenderServerToc(false, docToc)).toBe(false);
      expect(shouldRenderServerToc(true, [])).toBe(false);
    });

    it("handles pathological unclosed <h2>/<h3> inputs in strict O(n) time without quadratic rescanning", () => {
      const evilAttrs = '<h2 class="x" '.repeat(6_000) + ">Akhir";
      const start1 = performance.now();
      const res1 = extractAndInjectServerToc(evilAttrs);
      expect(performance.now() - start1).toBeLessThan(200);
      expect(res1.toc).toEqual([]);

      const repeatedH2 = "<h2>".repeat(20_000);
      const start2 = performance.now();
      const res2 = extractAndInjectServerToc(repeatedH2);
      expect(performance.now() - start2).toBeLessThan(200);
      expect(res2.toc).toEqual([]);

      const repeatedH3 = "<h3>".repeat(20_000);
      const start3 = performance.now();
      const res3 = extractAndInjectServerToc(repeatedH3);
      expect(performance.now() - start3).toBeLessThan(200);
      expect(res3.toc).toEqual([]);

      expect(slugifyTocHeadingText("Café & Crème Brûlée — 2026!", 1)).toBe("cafe-creme-brulee-2026");
    });
  });

  describe("Strict `content_modified_at` substantive diffing", () => {
    const basePost: SubstantivePostContentInput = {
      title: "Panduan Audit Gedung Perkantoran",
      excerpt: "Checklist praktis audit struktur dan MEP.",
      body: {
        schemaVersion: 1,
        blocks: [
          { type: "heading", level: 2, text: "Tahap Inspeksi" },
          { type: "paragraph", text: "Periksa panel listrik dan jalur evakuasi." },
        ],
      },
      sanitizedHtml: '<h2 id="tahap-inspeksi">Tahap Inspeksi</h2><p>Periksa panel listrik dan jalur evakuasi.</p>',
      coverMediaId: 10,
      authorId: 2,
      authorName: "Rina Kartika",
      primaryCategoryId: 5,
      categoryIds: [5, 7],
      tagIds: [12, 11],
      showToc: true,
      seo: {
        titleOverride: "Panduan Audit Gedung B2B",
        descriptionOverride: "Checklist praktis untuk pemilik gedung.",
      },
    };

    it("produces identical fingerprint regardless of category/tag order, whitespace, or legacy un-anchored heading HTML", () => {
      const reordered: SubstantivePostContentInput = {
        ...basePost,
        title: "  Panduan Audit Gedung Perkantoran  ",
        // Legacy pre-092 HTML without `id="..."` on headings
        sanitizedHtml: "<h2>Tahap Inspeksi</h2><p>Periksa panel listrik dan jalur evakuasi.</p>",
        categoryIds: [7, 5, 5],
        tagIds: [11, 12],
        tocEnabled: true,
      };
      expect(computeSubstantivePostFingerprint(basePost)).toBe(
        computeSubstantivePostFingerprint(reordered),
      );
      expect(hasSubstantivePublishedPostChange(basePost, reordered)).toBe(false);
    });

    it("preserves prior content_modified_at on non-substantive republish and advances on substantive edits", () => {
      const T1 = 1_860_000_000_000;
      const T2 = T1 + 3_600_000;
      const T3 = T2 + 3_600_000;

      // First publish sets content_modified_at = T1
      const first = resolvePublishedContentModifiedAt({
        priorPublished: null,
        nextPublished: basePost,
        priorContentModifiedAt: null,
        nowMs: T1,
      });
      expect(first.substantiveChanged).toBe(true);
      expect(first.contentModifiedAt).toBe(T1);

      // No-op republish at T2 preserves T1
      const noopRepublish = resolvePublishedContentModifiedAt({
        priorPublished: basePost,
        nextPublished: { ...basePost, tagIds: [11, 12] },
        priorContentModifiedAt: first.contentModifiedAt,
        priorFingerprint: first.fingerprint,
        nowMs: T2,
      });
      expect(noopRepublish.substantiveChanged).toBe(false);
      expect(noopRepublish.contentModifiedAt).toBe(T1);

      // Substantive edit (body text changed) advances content_modified_at to T3
      const substantiveEdit: SubstantivePostContentInput = {
        ...basePost,
        sanitizedHtml:
          '<h2 id="tahap-inspeksi">Tahap Inspeksi</h2><p>Periksa panel listrik, hydrant, dan jalur evakuasi.</p>',
      };
      const updated = resolvePublishedContentModifiedAt({
        priorPublished: basePost,
        nextPublished: substantiveEdit,
        priorContentModifiedAt: noopRepublish.contentModifiedAt,
        priorFingerprint: noopRepublish.fingerprint,
        nowMs: T3,
      });
      expect(updated.substantiveChanged).toBe(true);
      expect(updated.contentModifiedAt).toBe(T3);
      expect(updated.fingerprint).not.toBe(first.fingerprint);

      // Toggling TOC or changing author/category/SEO also counts as substantive
      expect(
        hasSubstantivePublishedPostChange(basePost, { ...basePost, showToc: false }),
      ).toBe(true);
      expect(
        hasSubstantivePublishedPostChange(basePost, { ...basePost, authorId: 3 }),
      ).toBe(true);
      expect(
        hasSubstantivePublishedPostChange(basePost, { ...basePost, primaryCategoryId: 7 }),
      ).toBe(true);
      expect(
        hasSubstantivePublishedPostChange(basePost, {
          ...basePost,
          seo: { titleOverride: "Judul SEO Baru" },
        }),
      ).toBe(true);
    });
  });

  describe("Author profile validation & byline/JSON-LD parity", () => {
    it("validates author fields, rejects XSS/overlength/invalid URLs, and builds 1:1 byline + JSON-LD", () => {
      const badXss = validateAuthorProfilePayload({
        name: "<script>alert(1)</script>",
        roleTitle: "x".repeat(101),
        bio: "b".repeat(301),
        sameAs: ["http://insecure.example.com", "javascript:alert(1)"],
      });
      expect(badXss.ok).toBe(false);
      if (!badXss.ok) {
        const fields = badXss.errors.map((e) => e.field);
        expect(fields).toContain("name");
        expect(fields).toContain("roleTitle");
        expect(fields).toContain("bio");
        expect(fields).toContain("sameAs");
      }

      const valid = validateAuthorProfilePayload({
        name: "Rina Kartika, S.Ars",
        roleTitle: "Principal Architect",
        bio: "12 tahun pengalaman audit gedung B2B.",
        avatarMediaId: 7,
        sameAs: ["https://linkedin.com/in/rinakartika"],
      });
      expect(valid.ok).toBe(true);
      if (valid.ok) {
        const parity = buildAuthorBylineAndSchemaParity({
          id: 1,
          name: valid.data.name,
          roleTitle: valid.data.roleTitle,
          bio: valid.data.bio,
          avatar: {
            id: 7,
            url: "https://cdn.punyasitus.com/t/01TEST/media/7/w640.webp",
            alt: "Foto profil Rina Kartika",
            width: 640,
            height: 640,
          },
          sameAs: valid.data.sameAs,
        });
        expect(parity.byline?.name).toBe("Rina Kartika, S.Ars");
        expect(parity.byline?.roleTitle).toBe("Principal Architect");
        expect(parity.articleAuthorSchema).toEqual({
          "@type": "Person",
          name: "Rina Kartika, S.Ars",
          jobTitle: "Principal Architect",
          description: "12 tahun pengalaman audit gedung B2B.",
          image: {
            "@type": "ImageObject",
            url: "https://cdn.punyasitus.com/t/01TEST/media/7/w640.webp",
            width: 640,
            height: 640,
            caption: "Foto profil Rina Kartika",
          },
          sameAs: ["https://linkedin.com/in/rinakartika"],
        });
      }

      // When byline is null, synchronizeBlogSchemaGraphAuthorAndDates explicitly clears stale author
      const synced = synchronizeBlogSchemaGraphAuthorAndDates(
        {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "BlogPosting",
              headline: "Artikel Tanpa Penulis",
              author: { "@type": "Person", name: "Stale Author" },
            },
          ],
        },
        {
          authorByline: null,
          publishedAtIso: "2026-11-10T00:00:00.000Z",
          modifiedAtIso: "2026-11-10T00:00:00.000Z",
        },
      );
      const articleNode = synced?.["@graph"]?.[0] as Record<string, unknown>;
      expect(articleNode.author).toBeUndefined();
    });
  });

  describe("Blog category depth <= 3 hierarchy validator", () => {
    const existing = [
      { id: 1, parentId: null, depth: 1 },
      { id: 2, parentId: 1, depth: 2 },
      { id: 3, parentId: 2, depth: 3 },
      { id: 4, parentId: null, depth: 1 },
      { id: 5, parentId: 4, depth: 2 },
    ] as const;

    it("allows depths 1, 2, 3 and rejects depth 4, cycles, and deep subtree reparenting", () => {
      expect(
        validateBlogCategoryDepth({ proposedParentId: null, existingCategories: existing }),
      ).toEqual({ ok: true, depth: 1, maxSubtreeDepth: 1 });

      expect(
        validateBlogCategoryDepth({ proposedParentId: 1, existingCategories: existing }),
      ).toEqual({ ok: true, depth: 2, maxSubtreeDepth: 2 });

      expect(
        validateBlogCategoryDepth({ proposedParentId: 2, existingCategories: existing }),
      ).toEqual({ ok: true, depth: 3, maxSubtreeDepth: 3 });

      // Depth 4 rejected!
      const depth4 = validateBlogCategoryDepth({
        proposedParentId: 3,
        existingCategories: existing,
      });
      expect(depth4.ok).toBe(false);
      if (!depth4.ok) expect(depth4.code).toBe("MAX_DEPTH_EXCEEDED");

      // Self-parent rejected
      const selfCycle = validateBlogCategoryDepth({
        categoryId: 2,
        proposedParentId: 2,
        existingCategories: existing,
      });
      expect(selfCycle.ok).toBe(false);
      if (!selfCycle.ok) expect(selfCycle.code).toBe("CYCLIC_PARENT");

      // Ancestor -> descendant cycle rejected
      const descCycle = validateBlogCategoryDepth({
        categoryId: 1,
        proposedParentId: 3,
        existingCategories: existing,
      });
      expect(descCycle.ok).toBe(false);
      if (!descCycle.ok) expect(descCycle.code).toBe("CYCLIC_PARENT");

      // Moving root #4 (which has child #5, height 1) under #2 (depth 2) would put #5 at depth 4 -> rejected
      const deepMove = validateBlogCategoryDepth({
        categoryId: 4,
        proposedParentId: 2,
        existingCategories: existing,
      });
      expect(deepMove.ok).toBe(false);
      if (!deepMove.ok) expect(deepMove.code).toBe("MAX_DEPTH_EXCEEDED");
    });
  });
});
