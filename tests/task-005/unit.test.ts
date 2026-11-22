import fs from "node:fs";
import path from "node:path";
import {
  PageLayoutModeSchema,
  PublicationValidationError,
  validateCanonicalOverride,
  validatePageLayoutMode,
  validatePageSeoOverrides,
} from "@punyasitus/core/content/index";
import {
  buildSuffixedSlug,
  isReservedSlug,
  MAX_SLUG_LENGTH,
  normalizeTitleToSlug,
  resolveUniqueAutoSlug,
  SlugValidationError,
  suggestAlternativeSlug,
  validateManualSlug,
} from "@punyasitus/core/slug/index";
import { PAGES_LAYOUT_MODE_MIGRATION_SQL } from "@punyasitus/db/pages/migrations";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-005 Unit — Shared Slug Engine, SEO Overrides & Landing Page Focus Mode", () => {
  it("keeps bundled 0003_pages_layout_mode.sql migration identical to SQL on disk", () => {
    const sqlOnDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0003_pages_layout_mode.sql"),
      "utf8",
    );
    expect(PAGES_LAYOUT_MODE_MIGRATION_SQL).toBe(sqlOnDisk);
  });

  describe("title-to-slug normalization (NFKD diacritics, 80-char cap, fallback)", () => {
    it("strips Unicode NFKD diacritics and transliterates special Latin letters to ASCII", () => {
      expect(normalizeTitleToSlug("Kafe Caffè Sêrū")).toBe("kafe-caffe-seru");
      expect(normalizeTitleToSlug("Crème Brûlée & Kopi Gula Aren!")).toBe(
        "creme-brulee-kopi-gula-aren",
      );
      expect(normalizeTitleToSlug("Über Straße — Łódź & Æsthetic")).toBe(
        "uber-strasse-lodz-aesthetic",
      );
      expect(normalizeTitleToSlug("   ---  Tentang   Kami  2026 ---  ")).toBe("tentang-kami-2026");
    });

    it("caps generated slugs at 80 characters cleanly on a word boundary without trailing hyphens", () => {
      const longTitle =
        "Panduan Lengkap Memilih Paket Wisata Keluarga Bali Lombok Nusa Penida Terbaik Sepanjang Tahun 2026";
      const slug = normalizeTitleToSlug(longTitle);
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
      expect(slug.endsWith("-")).toBe(false);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.includes("--")).toBe(false);
      expect(slug).toBe(
        "panduan-lengkap-memilih-paket-wisata-keluarga-bali-lombok-nusa-penida-terbaik",
      );

      // Single unbroken token > 80 chars hard-trims cleanly at 80
      const unbroken = "a".repeat(120);
      const unbrokenSlug = normalizeTitleToSlug(unbroken);
      expect(unbrokenSlug).toHaveLength(80);
      expect(unbrokenSlug).toBe("a".repeat(80));
    });

    it("produces safe fallback slugs when titles contain no ASCII alphanumerics", () => {
      expect(normalizeTitleToSlug("🎉🔥✨")).toBe("halaman");
      expect(normalizeTitleToSlug("日本語タイトル")).toBe("halaman");
      expect(normalizeTitleToSlug("日本語タイトル", { fallbackPrefix: "item" })).toBe("item");
      expect(
        normalizeTitleToSlug("日本語タイトル", { fallbackPrefix: "halaman", fallbackId: 42 }),
      ).toBe("halaman-42");
      expect(
        normalizeTitleToSlug("   ---   ", { fallbackPrefix: "post", fallbackId: 7 }),
      ).toBe("post-7");
    });
  });

  describe("automatic -2 / -3 suffixing and 80-char cap enforcement", () => {
    it("appends -2, -3 on collision while keeping length <= 80 chars", async () => {
      const taken = new Set<string>(["kafe-caffe-seru", "kafe-caffe-seru-2"]);
      const resolved = await resolveUniqueAutoSlug("kafe-caffe-seru", (c) => taken.has(c));
      expect(resolved).toBe("kafe-caffe-seru-3");

      // Exact 80-char base slug must truncate base before appending -2 / -12
      const base80 = "paket-wisata-keluarga-terbaik-di-bali-lombok-yogyakarta-bandung-malang-surabaya1";
      expect(base80).toHaveLength(80);
      const suffixed2 = buildSuffixedSlug(base80, 2);
      expect(suffixed2.length).toBeLessThanOrEqual(80);
      expect(suffixed2.endsWith("-2")).toBe(true);
      expect(suffixed2.includes("--")).toBe(false);

      const suffixed123 = buildSuffixedSlug("x".repeat(80), 123);
      expect(suffixed123).toHaveLength(80);
      expect(suffixed123.endsWith("-123")).toBe(true);
    });

    it("automatically skips reserved root slugs when auto-generating from title", async () => {
      const fromBlog = await resolveUniqueAutoSlug("blog", () => false, { namespace: "pages" });
      expect(fromBlog).toBe("blog-2");

      const fromApi = await resolveUniqueAutoSlug("api", () => false, { namespace: "pages" });
      expect(fromApi).toBe("api-2");

      const fromDashboard = await resolveUniqueAutoSlug("dashboard", () => false, {
        namespace: "pages",
      });
      expect(fromDashboard).toBe("dashboard-2");
    });

    it("suggests an available alternative slug on conflict", async () => {
      const taken = new Set(["promo", "promo-2"]);
      const suggestion = await suggestAlternativeSlug("promo", (c) => taken.has(c));
      expect(suggestion).toBe("promo-3");
    });
  });

  describe("strict manual slug validation & reserved slug rejection", () => {
    it("accepts clean lowercase ASCII hyphenated slugs up to 80 characters", () => {
      expect(validateManualSlug("tentang-kami")).toBe("tentang-kami");
      expect(validateManualSlug("a")).toBe("a");
      expect(validateManualSlug("promo-2026-q4")).toBe("promo-2026-q4");
      expect(validateManualSlug("a".repeat(80))).toBe("a".repeat(80));
    });

    it("rejects uppercase, invalid chars, leading/trailing/double hyphens, and >80 chars with INVALID_SLUG", () => {
      const invalidInputs: unknown[] = [
        "",
        "   ",
        "Tentang-Kami",
        "-leading",
        "trailing-",
        "double--hyphen",
        "tentang_kami",
        "tentang kami",
        "tentang/kami",
        "kafe-caffè",
        "a".repeat(81),
        123,
        null,
      ];

      for (const bad of invalidInputs) {
        try {
          validateManualSlug(bad);
          throw new Error(`Expected "${String(bad)}" to throw SlugValidationError`);
        } catch (err) {
          expect(err).toBeInstanceOf(SlugValidationError);
          expect((err as SlugValidationError).httpStatus).toBe(422);
          expect((err as SlugValidationError).code).toBe("INVALID_SLUG");
        }
      }
    });

    it("rejects all reserved root platform/public route slugs with RESERVED_SLUG (422)", () => {
      const reservedRoot = [
        "api",
        "dashboard",
        "console",
        "auth",
        "account",
        "admin",
        "agency",
        "affiliate",
        "platform",
        "blog",
        "produk",
        "layanan",
        "tour",
        "kendaraan",
        "katalog",
        "sitemap.xml",
        "robots.txt",
        "sitemaps",
        "feed.xml",
        "_astro",
        ".well-known",
        "preview",
        "assets",
        "static",
        "cdn-cgi",
        "health",
        "status",
        "login",
        "logout",
        "register",
        "mcp",
        "oauth2",
      ];

      for (const slug of reservedRoot) {
        expect(isReservedSlug(slug, "pages")).toBe(true);
        try {
          validateManualSlug(slug, { namespace: "pages" });
          throw new Error(`Expected reserved slug "${slug}" to throw`);
        } catch (err) {
          expect(err).toBeInstanceOf(SlugValidationError);
          expect((err as SlugValidationError).httpStatus).toBe(422);
          expect((err as SlugValidationError).code).toBe("RESERVED_SLUG");
        }
      }

      // Detail namespaces reserve `category` and `tag` while allowing normal item slugs
      expect(isReservedSlug("category", "blog")).toBe(true);
      expect(isReservedSlug("tag", "produk")).toBe(true);
      expect(validateManualSlug("kopi-arabika-gayo", { namespace: "produk" })).toBe(
        "kopi-arabika-gayo",
      );
    });
  });

  describe("SEO override & Landing Page Focus Mode validation", () => {
    it("accepts valid SEO overrides within bounds and safe canonical overrides", () => {
      const valid = validatePageSeoOverrides({
        seoTitle: "Promo Jasa Desain Web UMKM",
        seoDescription: "Layanan pembuatan website profesional untuk UMKM Indonesia dengan harga transparan.",
        ogImageMediaId: 12,
        noindex: true,
        nofollow: false,
        schemaType: "WebPage",
        canonicalOverride: "https://contoh-umkm.id/promo-web",
      });

      expect(valid).not.toBeNull();
      expect(valid?.seoTitle).toBe("Promo Jasa Desain Web UMKM");
      expect(valid?.noindex).toBe(true);
      expect(valid?.canonicalOverride).toBe("https://contoh-umkm.id/promo-web");

      expect(validateCanonicalOverride("/tentang-kami")).toBe("/tentang-kami");
      expect(validateCanonicalOverride("https://toko.id/halaman")).toBe("https://toko.id/halaman");
    });

    it("rejects oversized seoTitle (>70), seoDescription (>160), XSS tags, unsafe canonicals, and forbidden tenant selectors", () => {
      expect(() =>
        validatePageSeoOverrides({ seoTitle: "x".repeat(71) }),
      ).toThrow(PublicationValidationError);

      expect(() =>
        validatePageSeoOverrides({ seoDescription: "y".repeat(161) }),
      ).toThrow(PublicationValidationError);

      expect(() =>
        validatePageSeoOverrides({ seoTitle: "<script>alert(1)</script>" }),
      ).toThrow(PublicationValidationError);

      const unsafeCanonicals = [
        "javascript:alert(1)",
        "data:text/html,<h1>x</h1>",
        "http://insecure.example/page",
        "//evil.example/protocol-relative",
        "https://user:pass@example.com/secret",
        "https://localhost/admin",
        "https://127.0.0.1/internal",
        "https://192.168.1.1/lan",
        "/../etc/passwd",
        "/bad<script>",
      ];
      for (const badUrl of unsafeCanonicals) {
        expect(() => validatePageSeoOverrides({ canonicalOverride: badUrl })).toThrow(
          PublicationValidationError,
        );
      }

      // Unknown SEO field & forbidden tenant selector rejected
      expect(() => validatePageSeoOverrides({ unknownSeoKey: "boom" })).toThrow(
        PublicationValidationError,
      );
      expect(() => validatePageSeoOverrides({ tenantId: "01JOTHER000000000000000001" })).toThrow(
        PublicationValidationError,
      );
    });

    it("validates layoutMode strictly as standard | focused", () => {
      expect(PageLayoutModeSchema.parse("standard")).toBe("standard");
      expect(PageLayoutModeSchema.parse("focused")).toBe("focused");
      expect(validatePageLayoutMode("standard")).toBe("standard");
      expect(validatePageLayoutMode("focused")).toBe("focused");

      for (const invalid of ["minimal", "landing", "", "FOCUSED", 1, null, {}]) {
        expect(() => validatePageLayoutMode(invalid)).toThrow(PublicationValidationError);
      }
    });
  });
});
