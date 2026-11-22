import {
  buildUniqueAutoSlug,
  CatalogValidationError,
  formatCatalogPrice,
  generateSlugFromTitle,
  getOfferingPublicBasePath,
  getOfferingPublicPath,
  isReservedCatalogSlug,
  MAX_GALLERY_MEDIA_IDS,
  normalizeSlugSegment,
  projectToPublicOfferingAttributes,
  validateBadges,
  validateCatalogPricing,
  validateCategoryIds,
  validateCategoryInput,
  validateGalleryMediaIds,
  validateManualSlug,
  validateOfferingAttributes,
  validateOfferingCta,
  validateOfferingInput,
} from "@punyasitus/core/catalog/index";
import { describe, expect, it } from "vitest";

describe("TASK-009 unit — Typed Offerings & Categories Domain Validator", () => {
  describe("offering types, canonical paths & strict per-type attributes", () => {
    it("maps all 4 offering types to canonical Indonesian public base paths", () => {
      expect(getOfferingPublicBasePath("service")).toBe("/layanan");
      expect(getOfferingPublicBasePath("product")).toBe("/produk");
      expect(getOfferingPublicBasePath("tour")).toBe("/tour");
      expect(getOfferingPublicBasePath("vehicle")).toBe("/kendaraan");
      expect(getOfferingPublicPath("vehicle", "toyota-avanza-2024")).toBe(
        "/kendaraan/toyota-avanza-2024",
      );
    });

    it("validates strict attributes for service, product, tour, and vehicle", () => {
      const serviceAttrs = validateOfferingAttributes("service", {
        duration: "3 hari kerja",
        deliverables: ["Audit situs", "Laporan PDF"],
        turnaround: "72 jam",
        serviceMode: "hybrid",
        serviceArea: "Jabodetabek",
      });
      expect(serviceAttrs.serviceMode).toBe("hybrid");
      expect(projectToPublicOfferingAttributes("service", serviceAttrs)).toEqual({
        serviceSteps: ["Audit situs", "Laporan PDF"],
        serviceArea: "Jabodetabek",
      });

      const productAttrs = validateOfferingAttributes("product", {
        sku: "KOP-ARB-250",
        brand: "Kopi Nusantara",
        stockStatus: "ready",
        moq: 10,
        unit: "pack",
        weightGrams: 250,
        material: "Biji Arabika Gayo",
        variants: [{ name: "Gilingan", values: ["Whole Bean", "Medium", "Fine"] }],
      });
      expect(productAttrs.sku).toBe("KOP-ARB-250");
      expect(productAttrs.variants?.[0]?.values).toHaveLength(3);

      const tourAttrs = validateOfferingAttributes("tour", {
        durationDays: 9,
        destination: "Makkah & Madinah",
        departures: [
          { departureDate: "2027-01-15", seatsAvailable: 20, status: "open" },
          { departureDate: "2027-02-10", seatsAvailable: 4, status: "limited" },
        ],
        inclusions: ["Tiket PP", "Hotel bintang 4"],
        exclusions: ["Paspor", "Pengeluaran pribadi"],
        ppiuNumber: "PPIU-9921-2026",
        umrahLicense: "SK-KEMENAG-2026",
      });
      expect(tourAttrs.departures).toHaveLength(2);
      expect(projectToPublicOfferingAttributes("tour", tourAttrs)).toEqual({
        destination: "Makkah & Madinah",
        durationDays: 9,
        departureDates: ["2027-01-15", "2027-02-10"],
        inclusions: ["Tiket PP", "Hotel bintang 4"],
        exclusions: ["Paspor", "Pengeluaran pribadi"],
      });

      const vehicleAttrs = validateOfferingAttributes("vehicle", {
        brand: "Toyota",
        model: "Innova Zenix",
        year: 2025,
        condition: "used",
        transmission: "cvt",
        fuelType: "hybrid",
        mileageKm: 12500,
        color: "Putih Mutiara",
        plateRegion: "B (Jakarta)",
        otrPriceNote: "OTR DKI Jakarta",
        unitStatus: "available",
        creditEstimateEnabled: true,
      });
      expect(vehicleAttrs.mileageKm).toBe(12500);
      expect(projectToPublicOfferingAttributes("vehicle", vehicleAttrs)).toEqual({
        vehicleYear: 2025,
        transmission: "cvt",
        fuelType: "hybrid",
        mileageKm: 12500,
        creditEstimateEnabled: true,
      });
    });

    it("rejects unknown attributes, cross-type attributes, and new vehicles with positive mileage", () => {
      expect(() =>
        validateOfferingAttributes("service", {
          duration: "2 jam",
          sku: "WRONG-TYPE-FIELD",
        }),
      ).toThrowError(CatalogValidationError);

      expect(() =>
        validateOfferingAttributes("product", {
          brand: "Brand A",
          unknownSecret: true,
        }),
      ).toThrowError(CatalogValidationError);

      expect(() =>
        validateOfferingAttributes("vehicle", {
          brand: "Honda",
          model: "HR-V",
          condition: "new",
          mileageKm: 500,
        }),
      ).toThrowError(CatalogValidationError);

      expect(() =>
        validateOfferingInput(
          {
            offeringType: "product",
            title: "Kemeja Batik",
            priceMode: "fixed",
            price: 250_000,
            ctaMode: "inquiry",
            unitStatus: "available",
          },
          {},
        ),
      ).toThrowError(CatalogValidationError);
    });
  });

  describe("strict pricing modes, negotiable flag, and originalAmount", () => {
    it("accepts valid fixed, from, range, and on_request pricing and formats IDR accurately", () => {
      const fixed = validateCatalogPricing({
        priceMode: "fixed",
        price: 1_500_000,
        originalAmount: 1_800_000,
        negotiable: true,
      });
      expect(formatCatalogPrice(fixed)).toBe("Rp 1.500.000 (Nego)");

      const from = validateCatalogPricing({
        priceMode: "from",
        price: 500_000,
        negotiable: false,
      });
      expect(formatCatalogPrice(from)).toBe("Mulai Rp 500.000");

      const rangeEqual = validateCatalogPricing({
        priceMode: "range",
        price: 2_000_000,
        priceMax: 2_000_000,
      });
      expect(rangeEqual.priceMax).toBe(2_000_000);

      const rangeWide = validateCatalogPricing({
        priceMode: "range",
        price: 2_000_000,
        priceMax: 5_000_000,
        negotiable: true,
      });
      expect(formatCatalogPrice(rangeWide)).toBe("Rp 2.000.000 - Rp 5.000.000 (Nego)");

      const onRequest = validateCatalogPricing({ priceMode: "on_request" });
      expect(onRequest.price).toBeNull();
      expect(onRequest.priceMax).toBeNull();
      expect(formatCatalogPrice(onRequest)).toBe("Hubungi untuk harga");
    });

    it("rejects invalid pricing combinations across all 4 modes", () => {
      // fixed missing price or specifying priceMax
      expect(() => validateCatalogPricing({ priceMode: "fixed" })).toThrowError(
        CatalogValidationError,
      );
      expect(() =>
        validateCatalogPricing({ priceMode: "fixed", price: 100_000, priceMax: 200_000 }),
      ).toThrowError(CatalogValidationError);

      // from specifying priceMax or negative price
      expect(() =>
        validateCatalogPricing({ priceMode: "from", price: 100_000, priceMax: 150_000 }),
      ).toThrowError(CatalogValidationError);
      expect(() => validateCatalogPricing({ priceMode: "from", price: -1 })).toThrowError(
        CatalogValidationError,
      );

      // range with priceMax < price or missing priceMax
      expect(() =>
        validateCatalogPricing({ priceMode: "range", price: 500_000, priceMax: 499_999 }),
      ).toThrowError(CatalogValidationError);
      expect(() => validateCatalogPricing({ priceMode: "range", price: 500_000 })).toThrowError(
        CatalogValidationError,
      );

      // on_request with explicit price (even 0), priceMax, or originalAmount
      expect(() => validateCatalogPricing({ priceMode: "on_request", price: 0 })).toThrowError(
        CatalogValidationError,
      );
      expect(() =>
        validateCatalogPricing({ priceMode: "on_request", priceMax: 100_000 }),
      ).toThrowError(CatalogValidationError);
      expect(() =>
        validateCatalogPricing({ priceMode: "on_request", originalAmount: 100_000 }),
      ).toThrowError(CatalogValidationError);

      // originalAmount <= price
      expect(() =>
        validateCatalogPricing({ priceMode: "fixed", price: 250_000, originalAmount: 250_000 }),
      ).toThrowError(CatalogValidationError);
      expect(() =>
        validateCatalogPricing({ priceMode: "fixed", price: 250_000, originalAmount: 200_000 }),
      ).toThrowError(CatalogValidationError);
    });
  });

  describe("ordered gallery (<= 12 images), categories & badges", () => {
    it("preserves exact order for up to 12 unique positive media IDs and rejects >12 or duplicates", () => {
      const twelve = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      expect(validateGalleryMediaIds(twelve)).toEqual(twelve);
      expect(MAX_GALLERY_MEDIA_IDS).toBe(12);

      // 13 images fails
      expect(() => validateGalleryMediaIds([...twelve, 13])).toThrowError(CatalogValidationError);
      // duplicates fail
      expect(() => validateGalleryMediaIds([1, 2, 1])).toThrowError(CatalogValidationError);
      // zero / negative / float fail
      expect(() => validateGalleryMediaIds([0])).toThrowError(CatalogValidationError);
      expect(() => validateGalleryMediaIds([-5])).toThrowError(CatalogValidationError);
      expect(() => validateGalleryMediaIds([1.5])).toThrowError(CatalogValidationError);
    });

    it("enforces category ID uniqueness/cap and badge bounds", () => {
      expect(validateCategoryIds([3, 1, 2])).toEqual([3, 1, 2]);
      expect(() => validateCategoryIds([1, 1])).toThrowError(CatalogValidationError);
      expect(() => validateCategoryIds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toThrowError(
        CatalogValidationError,
      );

      expect(validateBadges("Promo", ["Promo", "Best Seller"])).toEqual({
        badge: "Promo",
        badges: ["Promo", "Best Seller"],
      });
      expect(() => validateBadges("x".repeat(41), undefined)).toThrowError(CatalogValidationError);
      expect(() =>
        validateBadges(undefined, ["A", "B", "C", "D", "E", "F"]),
      ).toThrowError(CatalogValidationError);
    });
  });

  describe("CTA discriminator validation (whatsapp, external_link, inquiry, book)", () => {
    it("validates whatsapp CTA against tenant E.164 config or offering override + template", () => {
      const viaTenant = validateOfferingCta({
        ctaMode: "whatsapp",
        tenantWhatsAppE164: "0812-3456-7890",
        whatsappTemplate: "Halo, saya mau pesan {{item_title}} ({{item_price}}) {{page_url}}",
      });
      expect(viaTenant.resolvedWhatsAppE164).toBe("6281234567890");

      const viaOverride = validateOfferingCta({
        ctaMode: "whatsapp",
        whatsappOverride: "+62 813-9999-8888",
        tenantWhatsAppE164: null,
      });
      expect(viaOverride.resolvedWhatsAppE164).toBe("6281399998888");
      expect(viaOverride.whatsappOverride).toBe("6281399998888");

      // Missing both tenant WA and override fails
      expect(() =>
        validateOfferingCta({ ctaMode: "whatsapp", tenantWhatsAppE164: null }),
      ).toThrowError(CatalogValidationError);

      // Invalid phone fails
      expect(() =>
        validateOfferingCta({ ctaMode: "whatsapp", whatsappOverride: "12345" }),
      ).toThrowError(CatalogValidationError);

      // Unknown template token fails
      expect(() =>
        validateOfferingCta({
          ctaMode: "whatsapp",
          tenantWhatsAppE164: "6281234567890",
          whatsappTemplate: "Halo {{secret_token}}",
        }),
      ).toThrowError(CatalogValidationError);
    });

    it("validates external_link CTA strictly via HTTPS link sanitizer and allows inquiry/book", () => {
      const ext = validateOfferingCta({
        ctaMode: "external_link",
        externalUrl: "https://www.tokopedia.com/toko-alpha/kopi-gayo",
      });
      expect(ext.externalUrl).toBe("https://www.tokopedia.com/toko-alpha/kopi-gayo");

      // Unsafe/missing external URLs fail
      for (const badUrl of [
        undefined,
        "",
        "javascript:alert(1)",
        "http://tokopedia.com/item",
        "data:text/html,<script>alert(1)</script>",
        "https://localhost/admin",
        "https://127.0.0.1/secret",
        "https://192.168.1.10/internal",
        "https://user:pass@tokopedia.com/item",
      ]) {
        expect(() =>
          validateOfferingCta({ ctaMode: "external_link", externalUrl: badUrl }),
        ).toThrowError(CatalogValidationError);
      }

      // inquiry and book do not require externalUrl or WA config
      expect(validateOfferingCta({ ctaMode: "inquiry" }).ctaMode).toBe("inquiry");
      expect(validateOfferingCta({ ctaMode: "book" }).ctaMode).toBe("book");
    });
  });

  describe("slug normalization, reserved slug rejection, and security guards", () => {
    it("normalizes diacritics, caps at 80 chars on word boundary, falls back for non-Latin, and appends -2", () => {
      expect(normalizeSlugSegment("Café Crème — Paket Wisata Bali!")).toBe(
        "cafe-creme-paket-wisata-bali",
      );

      const longTitle =
        "paket layanan konsultasi pajak bisnis perusahaan skala menengah dan besar di seluruh indonesia tahun ini";
      const capped = normalizeSlugSegment(longTitle);
      expect(capped.length).toBeLessThanOrEqual(80);
      expect(capped.endsWith("-")).toBe(false);

      expect(generateSlugFromTitle("日本語のタイトル", "produk", 42)).toBe("produk-42");

      const taken = new Set(["paket-umrah", "paket-umrah-2"]);
      expect(buildUniqueAutoSlug("paket-umrah", (s) => taken.has(s))).toBe("paket-umrah-3");
    });

    it("rejects reserved slugs, forbidden tenant selectors, and unknown fields", () => {
      for (const reserved of ["api", "blog", "layanan", "produk", "tour", "kendaraan", "category", "admin"]) {
        expect(isReservedCatalogSlug(reserved)).toBe(true);
        expect(() => validateManualSlug(reserved)).toThrowError(CatalogValidationError);
      }

      expect(() =>
        validateOfferingInput({
          tenantId: "01JATTACKER000000000000000",
          offeringType: "service",
          title: "Jasa Audit",
          priceMode: "on_request",
          ctaMode: "inquiry",
        }),
      ).toThrowError(CatalogValidationError);

      expect(() =>
        validateCategoryInput({
          name: "Mobil Keluarga",
          organizationId: "org-evil",
        }),
      ).toThrowError(CatalogValidationError);
    });
  });
});
