import {
  IdentityValidationError,
  normalizeBusinessPhone,
  normalizeIdentityRequestPayload,
  validateBusinessProfileInput,
  validateIdentityEmail,
  validateIdentityUrl,
  validateIdentityWhatsApp,
  validateLocale,
  validateSiteSettingsInput,
  validateSocialLinks,
  validateTimezone,
} from "@punyasitus/db/identity/index";
import { describe, expect, it } from "vitest";

function expectValidationError(fn: () => unknown, expectedFieldCode?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(IdentityValidationError);
  const err = caught as IdentityValidationError;
  expect(err.httpStatus).toBe(422);
  expect(err.code).toBe("VALIDATION_ERROR");
  if (expectedFieldCode) {
    expect(err.fields.some((f) => f.code === expectedFieldCode)).toBe(true);
  }
}

describe("TASK-008 unit — Site Identity & Brand Configuration validation rules", () => {
  describe("siteTitle, tagline, timezone, locale, theme & brand logo media IDs", () => {
    it("validates and normalizes complete siteSettings including light/dark logos", () => {
      const result = validateSiteSettingsInput({
        siteTitle: "  Kopi Nusantara  ",
        tagline: "  Kopi Spesialti Indonesia  ",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
        logoLightMediaId: 10,
        logoDarkMediaId: 11,
        faviconMediaId: 12,
        ogImageMediaId: 13,
        blogEnabled: true,
        catalogEnabled: false,
        aiTrainingPolicy: "disallow",
        siteVisibility: "public",
      });

      expect(result.snapshot.siteTitle).toBe("Kopi Nusantara");
      expect(result.snapshot.tagline).toBe("Kopi Spesialti Indonesia");
      expect(result.snapshot.faviconMediaId).toBe(12);
      expect(result.snapshot.ogImageMediaId).toBe(13);
      expect(result.snapshot.catalogEnabled).toBe(false);
      expect(result.snapshot.aiTrainingPolicy).toBe("disallow");
      expect(result.brandAssets).toEqual({
        logoMediaId: 10,
        logoLightMediaId: 10,
        logoDarkMediaId: 11,
      });
      expect(result.full.logoMediaId).toBe(10);
      expect(result.full.logoDarkMediaId).toBe(11);
    });

    it("mirrors logoMediaId to logoLightMediaId and rejects conflicting values", () => {
      const mirrored = validateSiteSettingsInput({
        siteTitle: "Alpha Studio",
        logoMediaId: 5,
      });
      expect(mirrored.brandAssets).toEqual({
        logoMediaId: 5,
        logoLightMediaId: 5,
        logoDarkMediaId: null,
      });

      expectValidationError(
        () =>
          validateSiteSettingsInput({
            siteTitle: "Alpha Studio",
            logoMediaId: 5,
            logoLightMediaId: 6,
          }),
        "CONFLICTING_LOGO_MEDIA_ID",
      );
    });

    it("rejects empty, oversized, or control-character siteTitle and invalid media IDs", () => {
      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "   " }),
        "INVALID_SITE_TITLE",
      );
      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "A".repeat(121) }),
        "INVALID_SITE_TITLE",
      );
      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "Kopi\u0000Nusantara" }),
        "INVALID_SITE_TITLE",
      );
      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "Baris1\nBaris2" }),
        "INVALID_SITE_TITLE",
      );
      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "Valid", faviconMediaId: 0 }),
        "INVALID_MEDIA_ID",
      );
      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "Valid", ogImageMediaId: -3 }),
        "INVALID_MEDIA_ID",
      );
      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "Valid", logoMediaId: "abc" }),
        "INVALID_MEDIA_ID",
      );
    });

    it("validates IANA timezone, BCP-47 locale, and registered theme IDs", () => {
      expect(validateTimezone("Asia/Makassar")).toBe("Asia/Makassar");
      expectValidationError(() => validateTimezone("Mars/Olympus"), "INVALID_TIMEZONE");

      expect(validateLocale("id-ID")).toBe("id-ID");
      expect(validateLocale("en-US")).toBe("en-US");
      expectValidationError(() => validateLocale("id_ID"), "INVALID_LOCALE");
      expectValidationError(() => validateLocale("123"), "INVALID_LOCALE");

      expectValidationError(
        () => validateSiteSettingsInput({ siteTitle: "Valid", activeThemeId: "evil_theme" }),
        "INVALID_THEME_ID",
      );
    });
  });

  describe("WhatsApp E.164, phone, email, businessCategory & coordinates", () => {
    it("normalizes Indonesian WhatsApp numbers and rejects invalid formats", () => {
      expect(validateIdentityWhatsApp("0812-3456-7890")).toBe("6281234567890");
      expect(validateIdentityWhatsApp("+62 811 2233 4455")).toBe("6281122334455");
      expect(validateIdentityWhatsApp("6285712345678")).toBe("6285712345678");
      expect(validateIdentityWhatsApp(null)).toBeNull();
      expect(validateIdentityWhatsApp("")).toBeNull();

      // Rejects landlines, non-Indonesian E.164, short strings, control chars
      expectValidationError(() => validateIdentityWhatsApp("021-7123456"), "INVALID_WHATSAPP");
      expectValidationError(() => validateIdentityWhatsApp("+14155551234"), "INVALID_WHATSAPP");
      expectValidationError(() => validateIdentityWhatsApp("081234"), "INVALID_WHATSAPP");
      expectValidationError(() => validateIdentityWhatsApp("62812\r\n34567"), "INVALID_WHATSAPP");
    });

    it("normalizes general business phone numbers including Indonesian landlines", () => {
      expect(normalizeBusinessPhone("021-7123456")).toBe("62217123456");
      expect(normalizeBusinessPhone("+62 (21) 712-3456")).toBe("62217123456");
      expect(normalizeBusinessPhone("0812 3456 7890")).toBe("6281234567890");
      expect(normalizeBusinessPhone(null)).toBeNull();

      expectValidationError(() => normalizeBusinessPhone("abc-12345678"), "INVALID_PHONE");
      expectValidationError(() => normalizeBusinessPhone("12345"), "INVALID_PHONE");
      expectValidationError(() => normalizeBusinessPhone("(021 7123456"), "INVALID_PHONE");
    });

    it("validates and lowercases email addresses", () => {
      expect(validateIdentityEmail("  Halo@KopiNusantara.ID ")).toBe("halo@kopinusantara.id");
      expect(validateIdentityEmail(null)).toBeNull();
      expectValidationError(() => validateIdentityEmail("not-an-email"), "INVALID_EMAIL");
      expectValidationError(() => validateIdentityEmail("a@b.com\ncc:evil@x.com"), "INVALID_EMAIL");
    });

    it("rejects deprecated ProfessionalService category and unpaired coordinates", () => {
      const ok = validateBusinessProfileInput({
        businessName: "PT Kopi Nusantara",
        businessCategory: "CafeOrCoffeeShop",
        latitude: -6.2607,
        longitude: 106.8131,
        whatsappE164: "0812-3456-7890",
        phone: "021-7123456",
        email: "halo@kopinusantara.id",
        mapsUrl: "https://maps.google.com/?q=-6.2607,106.8131",
        socialLinks: [{ platform: "instagram", url: "https://instagram.com/kopinusantara" }],
      });
      expect(ok.whatsappE164).toBe("6281234567890");
      expect(ok.phone).toBe("62217123456");
      expect(ok.businessCategory).toBe("CafeOrCoffeeShop");

      expectValidationError(
        () =>
          validateBusinessProfileInput({
            businessName: "Kantor Hukum",
            businessCategory: "ProfessionalService",
          }),
        "INVALID_BUSINESS_CATEGORY",
      );

      expectValidationError(
        () =>
          validateBusinessProfileInput({
            businessName: "PT Maju",
            latitude: -6.2,
            longitude: null,
          }),
        "INVALID_COORDINATES",
      );

      expectValidationError(
        () =>
          validateBusinessProfileInput({
            businessName: "PT\u0007Maju",
          }),
        "INVALID_BUSINESS_NAME",
      );
    });
  });

  describe("mapsUrl & socialLinks HTTPS sanitization (link-sanitizer)", () => {
    it("accepts public HTTPS URLs and rejects javascript:, http:, data:, credentials, and private/local hosts", () => {
      expect(validateIdentityUrl("https://maps.google.com/?q=-6.2,106.8", "mapsUrl")).toBe(
        "https://maps.google.com/?q=-6.2,106.8",
      );

      const unsafeUrls = [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "http://maps.google.com/?q=1",
        "data:text/html,<script>alert(1)</script>",
        "https://localhost/admin",
        "https://127.0.0.1/secret",
        "https://10.0.0.5/internal",
        "https://169.254.169.254/latest/meta-data",
        "https://192.168.1.1/router",
        "https://user:pass@instagram.com/account",
        "https://intranet/path",
        "https://instagram.com/ok\u0000",
      ];

      for (const bad of unsafeUrls) {
        expectValidationError(() => validateIdentityUrl(bad, "mapsUrl"), "UNSAFE_URL");
      }
    });

    it("validates socialLinks platform allowlist, URL safety, unknown keys, and max length", () => {
      const links = validateSocialLinks([
        { platform: "instagram", url: "https://instagram.com/brand" },
        { platform: "tiktok", url: "https://www.tiktok.com/@brand" },
      ]);
      expect(links).toHaveLength(2);

      expectValidationError(
        () => validateSocialLinks([{ platform: "myspace", url: "https://example.com" }]),
        "INVALID_SOCIAL_PLATFORM",
      );
      expectValidationError(
        () => validateSocialLinks([{ platform: "instagram", url: "javascript:void(0)" }]),
        "UNSAFE_URL",
      );
      expectValidationError(
        () =>
          validateSocialLinks([
            { platform: "instagram", url: "https://instagram.com/brand", extra: "nope" },
          ]),
        "UNKNOWN_FIELD",
      );
      expectValidationError(
        () =>
          validateSocialLinks(
            Array.from({ length: 11 }, (_, i) => ({
              platform: "website",
              url: `https://example.com/${i}`,
            })),
          ),
        "INVALID_SOCIAL_LINKS",
      );
    });
  });

  describe("strict payload normalization (unknown fields & forbidden tenant selectors)", () => {
    it("rejects unknown fields, forbidden tenant selectors, duplicate flat+nested keys, and empty patches", () => {
      expectValidationError(
        () => normalizeIdentityRequestPayload({ siteTitle: "OK", unknownKey: 123 }),
        "UNKNOWN_FIELD",
      );
      expectValidationError(
        () =>
          normalizeIdentityRequestPayload({
            siteSettings: { siteTitle: "OK", customHtml: "<script>" },
          }),
        "UNKNOWN_FIELD",
      );
      expectValidationError(
        () => normalizeIdentityRequestPayload({ tenantId: "01JFAKE", siteTitle: "OK" }),
        "FORBIDDEN_TENANT_SELECTOR",
      );
      expectValidationError(
        () =>
          normalizeIdentityRequestPayload({
            businessProfile: { businessName: "OK", organizationId: "org_other" },
          }),
        "FORBIDDEN_TENANT_SELECTOR",
      );
      expectValidationError(
        () =>
          normalizeIdentityRequestPayload({
            siteTitle: "Flat",
            siteSettings: { siteTitle: "Nested" },
          }),
        "DUPLICATE_FIELD",
      );
      expectValidationError(
        () => normalizeIdentityRequestPayload({ expectedVersion: 1 }),
        "EMPTY_IDENTITY_PATCH",
      );
    });
  });
});
