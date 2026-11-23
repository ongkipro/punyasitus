import fs from "node:fs";
import path from "node:path";
import {
  CLOSED_SECTION_TYPES,
  PLATFORM_THEME_IDS,
} from "@punyasitus/core/theme/index";
import {
  ALL_STYLE_VARIANTS,
  BUILTIN_STYLE_VARIANTS,
  PREMIUM_STYLE_VARIANTS,
  PREMIUM_THEME_CATALOG_SPECS,
  THEME_RECEIPT_NUMBER_PATTERN,
  THEME_STORE_FORBIDDEN_PRICE_KEYS,
  WCAG_AA_MIN_CONTRAST_RATIO,
  calculateRawWcagContrastRatio,
  calculateWcagContrastRatio,
  computeThemeStoreCheckoutQuote,
  countVariantCustomFonts,
  formatThemeReceiptNumber,
  generateThemeStoreReceiptPdf,
  getStyleVariantsForTheme,
  isThemeStoreReceiptPdfValid,
  renderStyleVariantCssVariables,
  switchThemeVariantLosslessly,
  verifyStyleVariantContrast,
} from "@punyasitus/core/theme/variants";
import {
  COMMERCIAL_THEME_STORE_PLATFORM_MIGRATION_SQL,
  TENANT_THEME_STYLE_VARIANTS_MIGRATION_SQL,
} from "@punyasitus/db/themes/store/migrations";
import { describe, expect, it } from "vitest";
import { CATALOG_THEME_MANIFEST } from "../../apps/web/src/themes/catalog/theme.ts";
import { COMPRO_THEME_MANIFEST } from "../../apps/web/src/themes/compro/theme.ts";
import { DEALER_THEME_MANIFEST } from "../../apps/web/src/themes/dealer/theme.ts";
import { CURATED_PREMIUM_THEMES } from "../../apps/web/src/themes/premium/catalog.ts";
import { RESTO_THEME_MANIFEST } from "../../apps/web/src/themes/resto/theme.ts";
import { SALES_THEME_MANIFEST } from "../../apps/web/src/themes/sales/theme.ts";
import { TRAVEL_THEME_MANIFEST } from "../../apps/web/src/themes/travel/theme.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function collectFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

describe("TASK-096 Unit: >=24 WCAG-AA Style Variants, Commercial Theme Store & PDF Receipts", () => {
  it("computes deterministic WCAG 2.1 contrast ratios accurately and enforces unrounded >= 4.5 threshold", () => {
    expect(calculateWcagContrastRatio("#000000", "#ffffff")).toBe(21);
    expect(calculateWcagContrastRatio("#ffffff", "#000000")).toBe(21);
    expect(calculateWcagContrastRatio("#176b51", "#176b51")).toBe(1);
    // Low-contrast gray on white must fail WCAG AA normal text (< 4.5)
    expect(calculateWcagContrastRatio("#9ca3af", "#ffffff")).toBeLessThan(WCAG_AA_MIN_CONTRAST_RATIO);
    // Dark emerald on white passes WCAG AA (>= 4.5)
    expect(calculateWcagContrastRatio("#176b51", "#ffffff")).toBeGreaterThanOrEqual(
      WCAG_AA_MIN_CONTRAST_RATIO,
    );

    // Boundary check: #767776 on #ffffff rounds to 4.50 but has raw ratio ~4.496 < 4.5 -> MUST FAIL!
    const rawBoundary = calculateRawWcagContrastRatio("#767776", "#ffffff");
    expect(rawBoundary).toBeLessThan(WCAG_AA_MIN_CONTRAST_RATIO);
    expect(calculateWcagContrastRatio("#767776", "#ffffff")).toBe(4.5);

    const sampleVariant = BUILTIN_STYLE_VARIANTS[0]!;
    const boundaryReport = verifyStyleVariantContrast({
      ...sampleVariant,
      colors: {
        ...sampleVariant.colors,
        surface: "#ffffff",
        text: "#767776",
      },
    });
    expect(boundaryReport.passed).toBe(false);
    expect(boundaryReport.minRawRatio).toBeLessThan(WCAG_AA_MIN_CONTRAST_RATIO);
    expect(boundaryReport.failures.some((f) => f.pairName === "text_on_surface")).toBe(true);
  });

  it("ships >=24 built-in Style Variants (>=4 per each of the 6 platform themes) all passing WCAG AA >= 4.5:1 and <= 1 custom font", () => {
    expect(BUILTIN_STYLE_VARIANTS.length).toBeGreaterThanOrEqual(24);

    const platformManifests = [
      COMPRO_THEME_MANIFEST,
      SALES_THEME_MANIFEST,
      TRAVEL_THEME_MANIFEST,
      CATALOG_THEME_MANIFEST,
      RESTO_THEME_MANIFEST,
      DEALER_THEME_MANIFEST,
    ] as const;

    for (const themeId of PLATFORM_THEME_IDS) {
      const variants = getStyleVariantsForTheme(themeId);
      expect(variants.length, `Theme ${themeId} must ship >= 4 variants`).toBeGreaterThanOrEqual(4);
      const manifest = platformManifests.find((m) => m.id === themeId);
      expect(manifest).toBeDefined();
      expect(manifest!.styleVariants.length).toBeGreaterThanOrEqual(4);
      // Every theme must have unique styleVariantKeys
      const keys = new Set(variants.map((v) => v.styleVariantKey));
      expect(keys.size).toBe(variants.length);
    }

    for (const variant of BUILTIN_STYLE_VARIANTS) {
      const report = verifyStyleVariantContrast(variant);
      expect(
        report.failures,
        `Variant ${variant.id} failed WCAG AA contrast: ${JSON.stringify(report.failures)}`,
      ).toEqual([]);
      expect(report.passed, `Variant ${variant.id} must pass WCAG AA`).toBe(true);
      expect(report.minRawRatio).toBeGreaterThanOrEqual(WCAG_AA_MIN_CONTRAST_RATIO);
      expect(report.minRatio).toBeGreaterThanOrEqual(WCAG_AA_MIN_CONTRAST_RATIO);
      expect(countVariantCustomFonts(variant.tokens)).toBeLessThanOrEqual(1);
      expect(report.fontBudgetPassed).toBe(true);

      // Safe CSS emission with zero dangerous syntax
      const css = renderStyleVariantCssVariables(variant);
      expect(css).toContain(":root {");
      expect(css).not.toMatch(/url\s*\(|expression\s*\(|@import|javascript:/i);
    }
  });

  it("ships >=2 curated paid_once premium themes with WCAG AA >= 4.5:1 variants, <= 1 custom font, and full closed section support", () => {
    expect(CURATED_PREMIUM_THEMES.length).toBeGreaterThanOrEqual(2);
    expect(PREMIUM_THEME_CATALOG_SPECS.length).toBeGreaterThanOrEqual(2);
    expect(PREMIUM_STYLE_VARIANTS.length).toBeGreaterThanOrEqual(4);

    for (const theme of CURATED_PREMIUM_THEMES) {
      expect(theme.tier).toBe("paid_once");
      expect(theme.priceIdr).toBeGreaterThanOrEqual(10_000);
      expect(theme.fontBudget.maxCustomFonts).toBe(1);
      expect(theme.supportedSectionTypes).toEqual(CLOSED_SECTION_TYPES);
      expect(theme.styleVariants.length).toBeGreaterThanOrEqual(2);

      for (const variant of theme.styleVariants) {
        const report = verifyStyleVariantContrast(variant);
        expect(
          report.failures,
          `Premium variant ${variant.id} failed WCAG AA: ${JSON.stringify(report.failures)}`,
        ).toEqual([]);
        expect(report.passed).toBe(true);
        expect(report.minRawRatio).toBeGreaterThanOrEqual(WCAG_AA_MIN_CONTRAST_RATIO);
        expect(report.customFontCount).toBeLessThanOrEqual(1);
      }
    }

    expect(ALL_STYLE_VARIANTS.length).toBe(
      BUILTIN_STYLE_VARIANTS.length + PREMIUM_STYLE_VARIANTS.length,
    );
  });

  it("preserves 100% of pages, sections, posts, and offerings across style variant and theme switches", () => {
    const pages = [
      { id: 1, slug: "beranda", sections: [{ id: "h1", type: "hero" }, { id: "o1", type: "offerings_grid" }] },
      { id: 2, slug: "tentang-kami", sections: [{ id: "a1", type: "about" }] },
    ] as const;
    const posts = [{ id: 10, slug: "panduan-umrah", title: "Panduan Umrah 2026" }] as const;
    const offerings = [{ id: 20, slug: "paket-vip", price: 32_000_000 }] as const;

    const switched1 = switchThemeVariantLosslessly(
      { themeId: "compro", styleVariantId: "clean-modern", pages, posts, offerings },
      { themeId: "compro", styleVariantId: "dark-executive" },
    );
    expect(switched1.contentPreserved).toBe(true);
    expect(switched1.nextStyleVariantId).toBe("dark-executive");
    expect(switched1.pages).toBe(pages);
    expect(switched1.posts).toBe(posts);
    expect(switched1.offerings).toBe(offerings);

    const switched2 = switchThemeVariantLosslessly(
      {
        themeId: switched1.nextThemeId,
        styleVariantId: switched1.nextStyleVariantId,
        pages: switched1.pages,
        posts: switched1.posts,
        offerings: switched1.offerings,
      },
      { themeId: "premium-atelier-editorial", styleVariantId: "midnight-atelier" },
    );
    expect(switched2.nextThemeId).toBe("premium-atelier-editorial");
    expect(switched2.nextStyleVariantId).toBe("midnight-atelier");
    expect(switched2.pages).toEqual(pages);
    expect(switched2.posts).toEqual(posts);
    expect(switched2.offerings).toEqual(offerings);
  });

  it("computes server-authoritative theme checkout math with single coupon and AutoLaris floor", () => {
    const nowMs = Date.UTC(2026, 10, 23, 10, 0, 0);
    const coupon = {
      id: "cpn_20",
      code: "HEMAT20",
      discountKind: "percent" as const,
      discountValue: 20,
      eligiblePayerTypes: ["tenant", "agency"] as const,
      maxRedemptions: 100,
      redeemedCount: 5,
      startsAtMs: nowMs - 86_400_000,
      endsAtMs: nowMs + 86_400_000,
      active: true,
    };

    const quote = computeThemeStoreCheckoutQuote({
      themeId: "premium-atelier-editorial",
      catalogPriceIdr: 499_000,
      channelCode: "VA_BCA",
      payerType: "tenant",
      coupon,
      rawCouponCode: "hemat20",
      nowMs,
    });
    expect(quote.basePriceIdr).toBe(499_000);
    expect(quote.discountAmountIdr).toBe(99_800);
    expect(quote.netBaseAmountIdr).toBe(399_200);
    expect(quote.channelFeeIdr).toBe(4_000);
    expect(quote.totalPayableIdr).toBe(403_200);
    expect(quote.couponCode).toBe("HEMAT20");

    // Reject coupon stacking
    expect(() =>
      computeThemeStoreCheckoutQuote({
        themeId: "premium-atelier-editorial",
        catalogPriceIdr: 499_000,
        channelCode: "QRIS",
        payerType: "tenant",
        rawCouponCode: "HEMAT20,EXTRA10",
        nowMs,
      }),
    ).toThrow(/penumpukan|stacking/i);

    // Reject discount driving net base below Rp 10.000 AutoLaris floor
    expect(() =>
      computeThemeStoreCheckoutQuote({
        themeId: "premium-atelier-editorial",
        catalogPriceIdr: 499_000,
        channelCode: "QRIS",
        payerType: "tenant",
        coupon: { ...coupon, discountKind: "fixed_idr", discountValue: 495_000 },
        rawCouponCode: "HEMAT20",
        nowMs,
      }),
    ).toThrow(/minimum|10\.000/i);

    // Forbidden client price keys list blocks client price tampering
    expect(THEME_STORE_FORBIDDEN_PRICE_KEYS.has("priceIdr")).toBe(true);
    expect(THEME_STORE_FORBIDDEN_PRICE_KEYS.has("totalPayableIdr")).toBe(true);
    expect(THEME_STORE_FORBIDDEN_PRICE_KEYS.has("discountAmountIdr")).toBe(true);
  });

  it("generates deterministic, structurally valid %PDF-1.4 numbered theme receipts (INV-THM-YYYY-NNNNNN)", async () => {
    const receiptNo = formatThemeReceiptNumber(2026, 42);
    expect(receiptNo).toBe("INV-THM-2026-000042");
    expect(THEME_RECEIPT_NUMBER_PATTERN.test(receiptNo)).toBe(true);

    const input = {
      receiptNumber: receiptNo,
      issuedAtMs: Date.UTC(2026, 10, 23, 12, 0, 0),
      tenantName: "Studio Nusantara",
      tenantHandle: "studio-nusantara",
      payerName: "Budi Santoso",
      themeId: "premium-atelier-editorial",
      themeName: "Atelier Editorial Pro",
      orderId: "01JT096ORDER00000000000001",
      baseAmountIdr: 499_000,
      discountAmountIdr: 99_800,
      channelFeeIdr: 0,
      totalAmountIdr: 399_200,
      couponCode: "HEMAT20",
      paymentChannel: "QRIS",
      providerReference: "AL-THM-REF001",
    } as const;

    const pdf1 = await generateThemeStoreReceiptPdf(input);
    const pdf2 = await generateThemeStoreReceiptPdf(input);

    expect(pdf1.headerSignature).toBe("%PDF-1.4");
    expect(await isThemeStoreReceiptPdfValid(pdf1.bytes)).toBe(true);
    expect(pdf1.sha256Hex).toBe(pdf2.sha256Hex);
    expect(pdf1.r2ObjectKey).toBe("platform/theme-receipts/2026/INV-THM-2026-000042.pdf");
    expect(pdf1.nonPkpNotice).toMatch(/non-?PKP|belum PKP/i);
  });

  it("keeps bundled migration SQL byte-for-byte identical to migration files on disk and passes static security guards", () => {
    const platformDisk = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/platform/0027_commercial_theme_store.sql"),
      "utf8",
    );
    const tenantDisk = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/tenant/0021_theme_style_variants.sql"),
      "utf8",
    );
    expect(COMMERCIAL_THEME_STORE_PLATFORM_MIGRATION_SQL).toBe(platformDisk);
    expect(TENANT_THEME_STYLE_VARIANTS_MIGRATION_SQL).toBe(tenantDisk);

    // Premium theme files: zero DB/auth/admin/Radix/Sparkles/eval/dynamic import
    const premiumFiles = collectFilesRecursive(path.join(REPO_ROOT, "apps/web/src/themes/premium"));
    expect(premiumFiles.length).toBeGreaterThanOrEqual(8);
    for (const file of premiumFiles) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${file} must not import @punyasitus/db`).not.toContain("@punyasitus/db");
      expect(src, `${file} must not import @punyasitus/auth`).not.toContain("@punyasitus/auth");
      expect(src, `${file} must not import @base-ui/react`).not.toContain("@base-ui/react");
      expect(src, `${file} must not use eval`).not.toMatch(/\beval\s*\(/);
      expect(src, `${file} must not reference Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }

    // Dashboard Theme Store UI: zero @radix-ui, zero asChild, zero Sparkles
    const uiFiles = collectFilesRecursive(
      path.join(REPO_ROOT, "apps/web/src/pages/dashboard/[handle]/appearance/themes"),
    );
    for (const file of uiFiles) {
      const src = fs.readFileSync(file, "utf8");
      expect(src).not.toMatch(/@radix-ui\//);
      expect(src).not.toMatch(/\basChild\b/);
      expect(src).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});
