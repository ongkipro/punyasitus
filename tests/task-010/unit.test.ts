import {
  buildCanonicalPageUrl,
  buildWhatsAppUrl,
  CANONICAL_WA_TOKENS,
  canonicalizePageUrl,
  DEFAULT_WA_TEMPLATE,
  formatOfferingPrice,
  MAX_E164_DIGITS,
  MAX_WA_TEMPLATE_LENGTH,
  normalizeIndonesianWhatsAppNumber,
  ON_REQUEST_PRICE_TEXT_ID,
  renderWhatsAppTemplate,
  validateIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "@punyasitus/core/wa-dispatcher";
import { describe, expect, it } from "vitest";

function expectWaError(fn: () => unknown, code: WhatsAppValidationError["code"]): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WhatsAppValidationError);
  expect((caught as WhatsAppValidationError).code).toBe(code);
}

describe("TASK-010: WhatsApp Dynamic CTA URL Generator & E.164 Validation", () => {
  describe("Indonesian E.164 mobile phone normalization", () => {
    it("normalizes valid 08, +628, and 628 numbers with ordinary separators", () => {
      expect(normalizeIndonesianWhatsAppNumber("081234567890")).toBe("6281234567890");
      expect(normalizeIndonesianWhatsAppNumber("+6281234567890")).toBe("6281234567890");
      expect(normalizeIndonesianWhatsAppNumber("6281234567890")).toBe("6281234567890");
      expect(normalizeIndonesianWhatsAppNumber("  0812-3456-7890  ")).toBe("6281234567890");
      expect(normalizeIndonesianWhatsAppNumber("+62 812-3456-7890")).toBe("6281234567890");
      expect(normalizeIndonesianWhatsAppNumber("(+62) 812 (3456) 7890")).toBe("6281234567890");
      expect(normalizeIndonesianWhatsAppNumber("(0812) 3456.7890")).toBe("6281234567890");
      expect(normalizeIndonesianWhatsAppNumber("62 857 1234 567")).toBe("628571234567");
    });

    it("accepts boundary Indonesian E.164 lengths (10 to 15 digits)", () => {
      expect(normalizeIndonesianWhatsAppNumber("081234567")).toBe("6281234567"); // 10 digits
      expect(normalizeIndonesianWhatsAppNumber("08123456789012")).toBe("628123456789012"); // 15 digits
      expect(normalizeIndonesianWhatsAppNumber("+628123456789012")).toHaveLength(MAX_E164_DIGITS);
    });

    it("rejects letters, bad prefixes, control characters, and invalid lengths", () => {
      const invalidNumbers = [
        "",
        "   ",
        "0812abc67890",
        "0812-3456-7890 ext 1",
        "02112345678", // Jakarta landline
        "07123456789", // Non-08 prefix
        "+14155552671", // Non-Indonesian country code
        "+62211234567", // Indonesian landline with +62
        "+08123456789", // +08 invalid
        "+620812345678", // +6208 invalid
        "620812345678", // 6208 invalid
        "00628123456789", // 0062 international exit prefix unsupported
        "81234567890", // Missing leading 0 or 62
        "08001234567", // Indonesian toll-free 0800, not mobile
        "08123456", // Too short (9 E.164 digits)
        "628123456", // Too short (9 E.164 digits)
        "6281234567890123", // 16 digits exceeds E.164 max 15
        "081234567890123", // 16 E.164 digits
        "++6281234567890", // Double plus
        "62+81234567890", // Misplaced plus
        "(0812-3456-7890", // Unbalanced parenthesis
        "0812-3456-7890\n", // Control character
        "0812/3456/7890", // Unsupported separator
      ];

      for (const raw of invalidNumbers) {
        expectWaError(() => normalizeIndonesianWhatsAppNumber(raw), "INVALID_PHONE");
        const checked = validateIndonesianWhatsAppNumber(raw);
        expect(checked.ok).toBe(false);
      }
    });

    it("returns structured success from validateIndonesianWhatsAppNumber", () => {
      expect(validateIndonesianWhatsAppNumber("0813-9876-5432")).toEqual({
        ok: true,
        phone: "6281398765432",
      });
    });
  });

  describe("Offering price formatting (REQ-016)", () => {
    it("formats fixed, from, range, negotiable, and on_request prices without implying free", () => {
      expect(formatOfferingPrice({ model: "fixed", amountIdr: 1_500_000 })).toBe("Rp 1.500.000");
      expect(formatOfferingPrice({ model: "fixed", amountIdr: 1_500_000, negotiable: true })).toBe(
        "Rp 1.500.000 (Nego)",
      );
      expect(formatOfferingPrice({ model: "from", amountIdr: 250_000 })).toBe("Mulai Rp 250.000");
      expect(
        formatOfferingPrice({
          model: "range",
          minAmountIdr: 1_500_000,
          maxAmountIdr: 2_750_000,
          negotiable: true,
        }),
      ).toBe("Rp 1.500.000 - Rp 2.750.000 (Nego)");

      const onRequest = formatOfferingPrice({ model: "on_request" });
      expect(onRequest).toBe(ON_REQUEST_PRICE_TEXT_ID);
      expect(onRequest.toLowerCase()).not.toContain("gratis");
      expect(onRequest).not.toContain("Rp 0");
    });

    it("rejects negative amounts, non-integers, and inverted ranges", () => {
      expectWaError(() => formatOfferingPrice({ model: "fixed", amountIdr: -1 }), "INVALID_PRICE");
      expectWaError(
        () => formatOfferingPrice({ model: "fixed", amountIdr: 12.5 }),
        "INVALID_PRICE",
      );
      expectWaError(
        () => formatOfferingPrice({ model: "range", minAmountIdr: 500_000, maxAmountIdr: 400_000 }),
        "INVALID_PRICE",
      );
    });
  });

  describe("Template expansion & canonical tokens", () => {
    it("exposes exact PLAN section 7.3 canonical tokens", () => {
      expect(CANONICAL_WA_TOKENS).toEqual(["item_title", "item_price", "page_url"]);
    });

    it("expands canonical tokens once without recursive double expansion", () => {
      const rendered = renderWhatsAppTemplate(
        "Halo, saya minat {{item_title}} ({{item_price}}).\nDetail: {{page_url}}",
        {
          item_title: "Paket {{page_url}} & {{unknown_token}}",
          item_price: "Rp 1.500.000",
          page_url: "https://alpha-studio.situsku.click/layanan/website-bisnis",
        },
      );

      expect(rendered).toBe(
        "Halo, saya minat Paket {{page_url}} & {{unknown_token}} (Rp 1.500.000).\nDetail: https://alpha-studio.situsku.click/layanan/website-bisnis",
      );
    });

    it("preserves literal dollar sequences ($&, $1, $$, $`, $'), Unicode/emoji, and line breaks", () => {
      const rendered = renderWhatsAppTemplate(
        "Halo 👋\nProduk: {{item_title}}\nHarga: {{item_price}}\nLink: {{page_url}} ✨",
        {
          item_title: "Promo $& $1 $$ $` $' Kopi Arabika ☕ — Rp 99K",
          item_price: "Rp 99.000",
          page_url: "https://alpha-studio.situsku.click/produk/kopi-arabika",
        },
      );

      expect(rendered).toBe(
        "Halo 👋\nProduk: Promo $& $1 $$ $` $' Kopi Arabika ☕ — Rp 99K\nHarga: Rp 99.000\nLink: https://alpha-studio.situsku.click/produk/kopi-arabika ✨",
      );
    });

    it("rejects unknown tokens, malformed delimiters, missing values, and >1000 char templates", () => {
      expectWaError(
        () => renderWhatsAppTemplate("Halo {{site_name}}", { item_title: "A" }),
        "UNKNOWN_TOKEN",
      );
      expectWaError(
        () => renderWhatsAppTemplate("Halo {{unknown}}", { item_title: "A" }),
        "UNKNOWN_TOKEN",
      );
      expectWaError(
        () => renderWhatsAppTemplate("Halo {{}}", { item_title: "A" }),
        "UNKNOWN_TOKEN",
      );
      expectWaError(
        () => renderWhatsAppTemplate("Halo {{ item_title }}", { item_title: "A" }),
        "UNKNOWN_TOKEN",
      );
      expectWaError(
        () => renderWhatsAppTemplate("Halo {{item_title", { item_title: "A" }),
        "INVALID_TEMPLATE",
      );
      expectWaError(
        () => renderWhatsAppTemplate("Halo item_title}}", { item_title: "A" }),
        "INVALID_TEMPLATE",
      );
      expectWaError(() => renderWhatsAppTemplate("   ", { item_title: "A" }), "INVALID_TEMPLATE");
      expectWaError(
        () => renderWhatsAppTemplate("Halo {{item_price}}", { item_title: "A" }),
        "MISSING_TOKEN_VALUE",
      );
      expectWaError(
        () =>
          renderWhatsAppTemplate("a".repeat(MAX_WA_TEMPLATE_LENGTH + 1), {
            item_title: "A",
          }),
        "TEMPLATE_TOO_LONG",
      );
    });
  });

  describe("Canonical page_url and full wa.me URL builder", () => {
    it("strips visitor query strings and hash fragments from page_url", () => {
      expect(
        buildCanonicalPageUrl(
          "https://alpha-studio.situsku.click",
          "/produk/kursi-jati?utm_source=meta&fbclid=xyz#spesifikasi",
        ),
      ).toBe("https://alpha-studio.situsku.click/produk/kursi-jati");

      expect(
        canonicalizePageUrl("https://beta-klinik.situsku.click/layanan/scaling?ref=ig#booking"),
      ).toBe("https://beta-klinik.situsku.click/layanan/scaling");
    });

    it("rejects protocol-relative paths, non-HTTPS origins, and credentials in page_url", () => {
      expectWaError(
        () => buildCanonicalPageUrl("http://alpha-studio.situsku.click", "/produk/a"),
        "INVALID_PAGE_URL",
      );
      expectWaError(
        () => buildCanonicalPageUrl("https://alpha-studio.situsku.click", "//evil.example/a"),
        "INVALID_PAGE_URL",
      );
      expectWaError(
        () => canonicalizePageUrl("https://user:pass@alpha-studio.situsku.click/produk/a"),
        "INVALID_PAGE_URL",
      );
    });

    it("builds a properly single-encoded wa.me URL and supports per-item phone override", () => {
      const result = buildWhatsAppUrl({
        tenantPhone: "0812-0000-1111",
        itemPhoneOverride: "+62 813-9999-8888",
        template: DEFAULT_WA_TEMPLATE,
        itemTitle: "Paket Umrah VIP $& $$ 🌙",
        itemPrice: { model: "from", amountIdr: 28_500_000 },
        primaryOrigin: "https://alpha-studio.situsku.click",
        canonicalPath: "/tour/umrah-vip?utm_campaign=ramadan#harga",
      });

      expect(result.phone).toBe("6281399998888");
      expect(result.pageUrl).toBe("https://alpha-studio.situsku.click/tour/umrah-vip");
      expect(result.message).toBe(
        "Halo, saya tertarik dengan Paket Umrah VIP $& $$ 🌙 (Mulai Rp 28.500.000).\nhttps://alpha-studio.situsku.click/tour/umrah-vip",
      );
      expect(result.url.startsWith("https://wa.me/6281399998888?text=")).toBe(true);
      // Verify single URL encoding (decoding once recovers exact message with no %25 double encoding)
      const parsed = new URL(result.url);
      expect(parsed.origin).toBe("https://wa.me");
      expect(parsed.pathname).toBe("/6281399998888");
      expect(parsed.searchParams.get("text")).toBe(result.message);
      expect(result.url).not.toContain("%2520");
    });

    it("falls back to tenantPhone when itemPhoneOverride is null/undefined/blank", () => {
      const result = buildWhatsAppUrl({
        tenantPhone: "0812-3456-7890",
        itemPhoneOverride: null,
        itemTitle: "Jasa Audit SEO",
        itemPrice: { model: "on_request" },
        pageUrl: "https://alpha-studio.situsku.click/layanan/audit-seo?gclid=123",
      });

      expect(result.phone).toBe("6281234567890");
      expect(result.message).toContain(ON_REQUEST_PRICE_TEXT_ID);
      expect(result.pageUrl).toBe("https://alpha-studio.situsku.click/layanan/audit-seo");
    });
  });
});
