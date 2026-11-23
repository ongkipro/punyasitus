import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { z } from "zod";
import { BILLING_CURRENCY, MAX_IDR_AMOUNT, MIN_AUTOLARIS_CHARGE_IDR } from "../billing/constants.ts";
import {
  AUTOLARIS_MIN_PAYMENT_IDR,
  parseSingleCouponCodeInput,
  type CouponDiscountKind,
  type CouponPayerType,
  type PromoCouponRecord,
} from "../billing/coupons.ts";
import { BillingValidationError } from "../billing/errors.ts";
import { assertExactIdrInteger, formatIdrDisplay } from "../billing/money.ts";
import {
  computeSha256Hex,
  formatWibDateTime,
  getWibYearFromEpochMs,
  RECEIPT_NON_PKP_NOTICE,
} from "../billing/receipt-pdf.ts";
import type { OfferingType } from "../schemas/common.ts";
import {
  PLATFORM_THEME_IDS,
  THEME_FONT_STACKS,
  ThemeTokensSchema,
  ThemeVariantsSchema,
  hasDangerousCssSyntax,
  sanitizeThemeColor,
  type AllowedThemeFont,
  type PlatformThemeId,
  type ThemeTokens,
  type ThemeVariants,
} from "./index.ts";

/**
 * Theme Style Variants, WCAG 2.1 AA Contrast Verification Engine, Commercial Theme Store
 * Pricing/Coupon Math & Numbered PDF Receipt Builder (`INV-THM-YYYY-NNNNNN`)
 * (REQ-096, REQ-018, REQ-020, REQ-046, REQ-081, REQ-082; ADR-0010; PLAN §11.4 & §19.7; DESIGN.md §7).
 *
 * Pure, runtime-neutral domain module (100% compatible with Node 22, Cloudflare `workerd`, and browsers):
 * - Ships >=24 WCAG-AA-verified built-in Style Variants (4 per each of the 6 platform themes)
 *   plus curated `paid_once` premium theme style variants (`<= 1` custom font per variant).
 * - Deterministic WCAG 2.1 relative-luminance contrast ratio calculator enforcing `>= 4.5:1`
 *   on EVERY primary/surface/muted/accent/CTA text-on-background pair.
 * - Strict server-side commercial theme checkout math with single-coupon support and
 *   AutoLaris `Rp 10.000` minimum payment floor (NEVER trusts client-supplied amounts).
 * - Deterministic `%PDF-1.4` numbered receipt generator (`INV-THM-YYYY-NNNNNN`) via `pdf-lib`.
 */

export const WCAG_AA_MIN_CONTRAST_RATIO = 4.5 as const;

export const PREMIUM_THEME_IDS = [
  "premium-atelier-editorial",
  "premium-nusantara-flagship",
] as const;
export type PremiumThemeId = (typeof PREMIUM_THEME_IDS)[number];

export const StoreThemeIdSchema = z
  .string()
  .regex(
    /^(?:compro|sales|travel|catalog|resto|dealer|(?:premium|custom)-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)$/,
    "Theme ID must be a platform theme, premium-<slug>, or custom-<slug>",
  );

export type StoreThemeTier = "included" | "paid_once" | "custom";

export type StyleVariantDensity = "airy" | "balanced" | "compact";

export interface StyleVariantColorPalette {
  readonly primary: string;
  readonly onPrimary: string;
  readonly secondary: string;
  readonly onSecondary: string;
  readonly accent: string;
  readonly onAccent: string;
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly text: string;
  readonly textMuted: string;
  readonly border: string;
  readonly ctaBg: string;
  readonly ctaText: string;
}

export interface ThemeStyleVariantDefinition {
  readonly id: string;
  readonly styleVariantKey: string;
  readonly themeId: PlatformThemeId | PremiumThemeId;
  readonly name: string;
  readonly tagline: string;
  readonly density: StyleVariantDensity;
  readonly mood: "light" | "warm" | "dark";
  readonly isDefault: boolean;
  readonly fontLabel: string;
  readonly swatches: readonly [string, string, string, string];
  readonly colors: StyleVariantColorPalette;
  readonly tokens: ThemeTokens;
  readonly variants: ThemeVariants;
}

export interface WcagContrastPairResult {
  readonly pairName: string;
  readonly foreground: string;
  readonly background: string;
  readonly rawRatio: number;
  readonly ratio: number;
  readonly minRequired: number;
  readonly passed: boolean;
}

export interface StyleVariantContrastReport {
  readonly variantId: string;
  readonly themeId: string;
  readonly passed: boolean;
  readonly minRawRatio: number;
  readonly minRatio: number;
  readonly customFontCount: number;
  readonly fontBudgetPassed: boolean;
  readonly pairs: readonly WcagContrastPairResult[];
  readonly failures: readonly WcagContrastPairResult[];
}

export interface PremiumThemeCatalogSpec {
  readonly id: PremiumThemeId;
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly version: string;
  readonly schemaVersion: 1;
  readonly tier: "paid_once";
  readonly defaultPriceIdr: number;
  readonly basePlatformThemeId: PlatformThemeId;
  readonly recommendedOfferingTypes: readonly OfferingType[];
  readonly highlights: readonly string[];
  readonly previewImagePath: string;
}

export const THEME_STORE_ERROR_CODES = [
  "THEME_NOT_ENTITLED",
  "THEME_ALREADY_ENTITLED",
  "THEME_ALREADY_OWNED",
  "OPEN_ORDER_EXISTS",
  "COUPON_EXHAUSTED",
  "THEME_NOT_PURCHASABLE",
  "THEME_GRANT_NOT_APPLICABLE",
  "THEME_VARIANT_NOT_FOUND",
  "THEME_ORDER_NOT_FOUND",
  "THEME_RECEIPT_NOT_FOUND",
  "THEME_CHECKOUT_CLIENT_PRICE_FORBIDDEN",
  "AUTOLARIS_ADVICE_UNCONFIGURED",
] as const;
export type ThemeStoreErrorCode = (typeof THEME_STORE_ERROR_CODES)[number];

export class ThemeStoreDomainError extends Error {
  readonly httpStatus: 400 | 403 | 404 | 409 | 422;
  readonly code: ThemeStoreErrorCode | string;
  readonly fields: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];

  constructor(
    httpStatus: 400 | 403 | 404 | 409 | 422,
    code: ThemeStoreErrorCode | string,
    message: string,
    fields: readonly { readonly field: string; readonly code: string; readonly message: string }[] = [],
  ) {
    super(message);
    this.name = "ThemeStoreDomainError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.fields = fields;
  }
}

export class ThemeNotEntitledError extends ThemeStoreDomainError {
  readonly themeId: string;

  constructor(themeId: string, message?: string) {
    super(
      403,
      "THEME_NOT_ENTITLED",
      message ??
        `Tema premium "${themeId}" belum dibeli untuk situs ini. Selesaikan pembayaran terlebih dahulu sebelum mengaktifkannya.`,
      [
        {
          field: "themeId",
          code: "THEME_NOT_ENTITLED",
          message: `Paid theme "${themeId}" is not entitled for this website.`,
        },
      ],
    );
    this.name = "ThemeNotEntitledError";
    this.themeId = themeId;
  }
}

// ---------------------------------------------------------------------------
// Deterministic WCAG 2.1 Relative Luminance & Contrast Ratio Calculator
// ---------------------------------------------------------------------------

export function parseHexToRgbTuple(hex: string): readonly [number, number, number] {
  const normalized = sanitizeThemeColor(hex, "color");
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function linearizeSrgbChannel(channel255: number): number {
  const s = channel255 / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Computes WCAG 2.1 relative luminance `L` in `[0, 1]` from a `#rgb` or `#rrggbb` hex string.
 */
export function computeRelativeLuminance(hex: string): number {
  const [r, g, b] = parseHexToRgbTuple(hex);
  return (
    0.2126 * linearizeSrgbChannel(r) +
    0.7152 * linearizeSrgbChannel(g) +
    0.0722 * linearizeSrgbChannel(b)
  );
}

/**
 * Computes exact unrounded WCAG 2.1 contrast ratio `(L1 + 0.05) / (L2 + 0.05)` in `[1, 21]`.
 * Always use this for strict WCAG threshold checks (`rawRatio >= 4.5`) so values like
 * `4.496` are never rounded up to pass `4.5`.
 */
export function calculateRawWcagContrastRatio(
  foregroundHex: string,
  backgroundHex: string,
): number {
  const l1 = computeRelativeLuminance(foregroundHex);
  const l2 = computeRelativeLuminance(backgroundHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Computes display-rounded WCAG 2.1 contrast ratio (`toFixed(2)`).
 */
export function calculateWcagContrastRatio(foregroundHex: string, backgroundHex: string): number {
  return Number(calculateRawWcagContrastRatio(foregroundHex, backgroundHex).toFixed(2));
}

/**
 * Counts distinct non-system self-hosted custom fonts referenced by a token bundle.
 * Platform & premium variants MUST keep this `<= 1` (REQ-020, REQ-096).
 */
export function countVariantCustomFonts(
  tokens: Pick<ThemeTokens, "fontFamily" | "headingFontFamily" | "fastestSystemFont">,
): number {
  if (tokens.fastestSystemFont) return 0;
  const customFonts = new Set<AllowedThemeFont>();
  if (tokens.fontFamily && tokens.fontFamily !== "system") {
    customFonts.add(tokens.fontFamily);
  }
  if (tokens.headingFontFamily && tokens.headingFontFamily !== "system") {
    customFonts.add(tokens.headingFontFamily);
  }
  return customFonts.size;
}

/**
 * Verifies every required normal-text foreground/background pair of a Style Variant
 * achieves WCAG 2.1 AA (`>= 4.5:1`) AND adheres to the `<= 1` custom font budget.
 */
export function verifyStyleVariantContrast(
  variant: Pick<ThemeStyleVariantDefinition, "id" | "themeId" | "colors" | "tokens">,
  minRatio: number = WCAG_AA_MIN_CONTRAST_RATIO,
): StyleVariantContrastReport {
  const c = variant.colors;
  const rawPairs: readonly [string, string, string][] = [
    ["text_on_surface", c.text, c.surface],
    ["text_on_surface_muted", c.text, c.surfaceMuted],
    ["text_muted_on_surface", c.textMuted, c.surface],
    ["text_muted_on_surface_muted", c.textMuted, c.surfaceMuted],
    ["primary_on_surface", c.primary, c.surface],
    ["on_primary_on_primary", c.onPrimary, c.primary],
    ["secondary_on_surface", c.secondary, c.surface],
    ["on_secondary_on_secondary", c.onSecondary, c.secondary],
    ["accent_on_surface", c.accent, c.surface],
    ["on_accent_on_accent", c.onAccent, c.accent],
    ["cta_text_on_cta_bg", c.ctaText, c.ctaBg],
  ];

  const pairs: WcagContrastPairResult[] = rawPairs.map(([pairName, fg, bg]) => {
    const rawRatio = calculateRawWcagContrastRatio(fg, bg);
    return {
      pairName,
      foreground: sanitizeThemeColor(fg, `${pairName}.fg`),
      background: sanitizeThemeColor(bg, `${pairName}.bg`),
      rawRatio,
      ratio: Number(rawRatio.toFixed(2)),
      minRequired: minRatio,
      passed: rawRatio >= minRatio,
    };
  });

  const failures = pairs.filter((p) => !p.passed);
  const minRawRatio = pairs.reduce((acc, p) => Math.min(acc, p.rawRatio), 21);
  const customFontCount = countVariantCustomFonts(variant.tokens);
  const fontBudgetPassed = customFontCount <= 1;

  return {
    variantId: variant.id,
    themeId: variant.themeId,
    passed: failures.length === 0 && fontBudgetPassed,
    minRawRatio,
    minRatio: Number(minRawRatio.toFixed(2)),
    customFontCount,
    fontBudgetPassed,
    pairs,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Curated Built-In Style Variants (>=24 across all 6 Platform Themes) + Premium Variants
// ---------------------------------------------------------------------------

interface StyleVariantSpecInput {
  readonly themeId: PlatformThemeId | PremiumThemeId;
  readonly styleVariantKey: string;
  readonly name: string;
  readonly tagline: string;
  readonly density: StyleVariantDensity;
  readonly mood: "light" | "warm" | "dark";
  readonly isDefault?: boolean;
  readonly fontFamily: AllowedThemeFont;
  readonly headingFontFamily?: AllowedThemeFont;
  readonly fontLabel: string;
  readonly borderRadiusPx: number;
  readonly spacingScale: number;
  readonly containerMaxWidthPx: number;
  readonly sectionPaddingYPx: number;
  readonly headerVariant: ThemeVariants["headerVariant"];
  readonly footerVariant: ThemeVariants["footerVariant"];
  readonly heroVariant: ThemeVariants["heroVariant"];
  readonly buttonStyle: ThemeVariants["buttonStyle"];
  readonly colors: StyleVariantColorPalette;
}

function defineStyleVariant(spec: StyleVariantSpecInput): ThemeStyleVariantDefinition {
  const id = `${spec.themeId}-${spec.styleVariantKey}`;
  const tokens = ThemeTokensSchema.parse({
    primaryColor: spec.colors.primary,
    secondaryColor: spec.colors.secondary,
    accentColor: spec.colors.accent,
    surfaceColor: spec.colors.surface,
    textColor: spec.colors.text,
    fontFamily: spec.fontFamily,
    ...(spec.headingFontFamily ? { headingFontFamily: spec.headingFontFamily } : {}),
    borderRadiusPx: spec.borderRadiusPx,
    spacingScale: spec.spacingScale,
    containerMaxWidthPx: spec.containerMaxWidthPx,
    sectionPaddingYPx: spec.sectionPaddingYPx,
    fastestSystemFont: spec.fontFamily === "system" && !spec.headingFontFamily,
  });

  const variants = ThemeVariantsSchema.parse({
    styleVariant: spec.styleVariantKey,
    headerVariant: spec.headerVariant,
    footerVariant: spec.footerVariant,
    heroVariant: spec.heroVariant,
    buttonStyle: spec.buttonStyle,
  });

  return Object.freeze({
    id,
    styleVariantKey: spec.styleVariantKey,
    themeId: spec.themeId,
    name: spec.name,
    tagline: spec.tagline,
    density: spec.density,
    mood: spec.mood,
    isDefault: spec.isDefault === true,
    fontLabel: spec.fontLabel,
    swatches: Object.freeze([
      spec.colors.primary,
      spec.colors.secondary,
      spec.colors.accent,
      spec.colors.surface,
    ] as const),
    colors: Object.freeze({ ...spec.colors }),
    tokens: Object.freeze(tokens),
    variants: Object.freeze(variants),
  });
}

export const BUILTIN_STYLE_VARIANTS: readonly ThemeStyleVariantDefinition[] = Object.freeze([
  // ── 1. COMPRO (4 variants) ────────────────────────────────────────────────
  defineStyleVariant({
    themeId: "compro",
    styleVariantKey: "clean-modern",
    name: "Clean Modern",
    tagline: "Zamrud korporat & slate tajam dengan sistem font tercepat.",
    density: "balanced",
    mood: "light",
    isDefault: true,
    fontFamily: "system",
    fontLabel: "Sistem (Tercepat)",
    borderRadiusPx: 8,
    spacingScale: 1,
    containerMaxWidthPx: 1200,
    sectionPaddingYPx: 64,
    headerVariant: "standard",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#176b51",
      onPrimary: "#ffffff",
      secondary: "#0f4c5c",
      onSecondary: "#ffffff",
      accent: "#1d4ed8",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f4f7f5",
      text: "#111c19",
      textMuted: "#465750",
      border: "#d8e2dc",
      ctaBg: "#176b51",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "compro",
    styleVariantKey: "bold-corporate",
    name: "Bold Corporate",
    tagline: "Navy institusional & aksen crimson tegas dengan sudut arsitektural.",
    density: "compact",
    mood: "light",
    fontFamily: "plus-jakarta-sans",
    fontLabel: "Plus Jakarta Sans",
    borderRadiusPx: 4,
    spacingScale: 0.95,
    containerMaxWidthPx: 1240,
    sectionPaddingYPx: 56,
    headerVariant: "sticky-cta",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#1e3a5f",
      onPrimary: "#ffffff",
      secondary: "#9f1239",
      onSecondary: "#ffffff",
      accent: "#0f5c5c",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f3f6fa",
      text: "#0f172a",
      textMuted: "#475569",
      border: "#cbd5e1",
      ctaBg: "#1e3a5f",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "compro",
    styleVariantKey: "warm-heritage",
    name: "Warm Heritage",
    tagline: "Hijau hutan & perunggu hangat pada permukaan gading editorial.",
    density: "airy",
    mood: "warm",
    fontFamily: "system",
    headingFontFamily: "lora",
    fontLabel: "Lora + Sistem",
    borderRadiusPx: 6,
    spacingScale: 1.05,
    containerMaxWidthPx: 1180,
    sectionPaddingYPx: 72,
    headerVariant: "standard",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#14532d",
      onPrimary: "#ffffff",
      secondary: "#7c2d12",
      onSecondary: "#ffffff",
      accent: "#1e40af",
      onAccent: "#ffffff",
      surface: "#fcfaf6",
      surfaceMuted: "#f3eee4",
      text: "#1a1815",
      textMuted: "#514a40",
      border: "#ddd5c7",
      ctaBg: "#14532d",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "compro",
    styleVariantKey: "dark-executive",
    name: "Dark Executive",
    tagline: "Permukaan slate gelap berwibawa dengan sorotan zamrud kontras tinggi.",
    density: "balanced",
    mood: "dark",
    fontFamily: "inter",
    fontLabel: "Inter",
    borderRadiusPx: 4,
    spacingScale: 1,
    containerMaxWidthPx: 1220,
    sectionPaddingYPx: 64,
    headerVariant: "sticky-cta",
    footerVariant: "compact",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#34d399",
      onPrimary: "#050505",
      secondary: "#38bdf8",
      onSecondary: "#050505",
      accent: "#fbbf24",
      onAccent: "#050505",
      surface: "#0f172a",
      surfaceMuted: "#1e293b",
      text: "#f8fafc",
      textMuted: "#cbd5e1",
      border: "#334155",
      ctaBg: "#34d399",
      ctaText: "#050505",
    },
  }),

  // ── 2. SALES (4 variants) ─────────────────────────────────────────────────
  defineStyleVariant({
    themeId: "sales",
    styleVariantKey: "high-conversion",
    name: "High-Conversion",
    tagline: "Biru royal & teal tepercaya dengan header CTA lengket untuk closing cepat.",
    density: "balanced",
    mood: "light",
    isDefault: true,
    fontFamily: "system",
    fontLabel: "Sistem (Tercepat)",
    borderRadiusPx: 8,
    spacingScale: 1,
    containerMaxWidthPx: 1160,
    sectionPaddingYPx: 64,
    headerVariant: "sticky-cta",
    footerVariant: "compact",
    heroVariant: "centered",
    buttonStyle: "solid",
    colors: {
      primary: "#1e40af",
      onPrimary: "#ffffff",
      secondary: "#0f766e",
      onSecondary: "#ffffff",
      accent: "#9a3412",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f5f7fb",
      text: "#0f172a",
      textMuted: "#475569",
      border: "#dbe3ee",
      ctaBg: "#1e40af",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "sales",
    styleVariantKey: "authority-editorial",
    name: "Authority Editorial",
    tagline: "Indigo tenang & amber untuk konsultan, dokter, advokat, dan pembicara.",
    density: "airy",
    mood: "light",
    fontFamily: "system",
    headingFontFamily: "merriweather",
    fontLabel: "Merriweather + Sistem",
    borderRadiusPx: 4,
    spacingScale: 1.05,
    containerMaxWidthPx: 1120,
    sectionPaddingYPx: 68,
    headerVariant: "minimal",
    footerVariant: "compact",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#312e81",
      onPrimary: "#ffffff",
      secondary: "#92400e",
      onSecondary: "#ffffff",
      accent: "#065f46",
      onAccent: "#ffffff",
      surface: "#fafafa",
      surfaceMuted: "#f1f0f5",
      text: "#18181b",
      textMuted: "#52525b",
      border: "#d4d4d8",
      ctaBg: "#312e81",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "sales",
    styleVariantKey: "emerald-trust",
    name: "Emerald Trust",
    tagline: "Zamrud hangat & navy ramah untuk agen properti, asuransi, dan jasa spesialis.",
    density: "balanced",
    mood: "light",
    fontFamily: "dm-sans",
    fontLabel: "DM Sans",
    borderRadiusPx: 10,
    spacingScale: 1,
    containerMaxWidthPx: 1180,
    sectionPaddingYPx: 60,
    headerVariant: "sticky-cta",
    footerVariant: "centered",
    heroVariant: "centered",
    buttonStyle: "solid",
    colors: {
      primary: "#065f46",
      onPrimary: "#ffffff",
      secondary: "#1e3a8a",
      onSecondary: "#ffffff",
      accent: "#9a3412",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f2f8f5",
      text: "#0f1f1a",
      textMuted: "#445952",
      border: "#d3e4dc",
      ctaBg: "#065f46",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "sales",
    styleVariantKey: "obsidian-closer",
    name: "Obsidian Closer",
    tagline: "Tema gelap kontras tinggi untuk kampanye iklan dan landing page fokus.",
    density: "compact",
    mood: "dark",
    fontFamily: "manrope",
    fontLabel: "Manrope",
    borderRadiusPx: 8,
    spacingScale: 0.95,
    containerMaxWidthPx: 1160,
    sectionPaddingYPx: 56,
    headerVariant: "sticky-cta",
    footerVariant: "compact",
    heroVariant: "centered",
    buttonStyle: "solid",
    colors: {
      primary: "#60a5fa",
      onPrimary: "#050505",
      secondary: "#2dd4bf",
      onSecondary: "#050505",
      accent: "#f59e0b",
      onAccent: "#050505",
      surface: "#111827",
      surfaceMuted: "#1f2937",
      text: "#f9fafb",
      textMuted: "#d1d5db",
      border: "#374151",
      ctaBg: "#60a5fa",
      ctaText: "#050505",
    },
  }),

  // ── 3. TRAVEL (4 variants) ────────────────────────────────────────────────
  defineStyleVariant({
    themeId: "travel",
    styleVariantKey: "oasis-emerald",
    name: "Oasis Emerald",
    tagline: "Teal teduh & oker hangat untuk biro perjalanan dan Umrah berizin resmi.",
    density: "balanced",
    mood: "light",
    isDefault: true,
    fontFamily: "system",
    fontLabel: "Sistem (Tercepat)",
    borderRadiusPx: 10,
    spacingScale: 1,
    containerMaxWidthPx: 1200,
    sectionPaddingYPx: 64,
    headerVariant: "standard",
    footerVariant: "columns",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#0f5c5c",
      onPrimary: "#ffffff",
      secondary: "#92400e",
      onSecondary: "#ffffff",
      accent: "#115e59",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f5f8f7",
      text: "#132221",
      textMuted: "#485c5a",
      border: "#d7e3e0",
      ctaBg: "#0f5c5c",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "travel",
    styleVariantKey: "haramain-heritage",
    name: "Haramain Heritage",
    tagline: "Hijau pinus & cokelat keemasan khidmat dengan tipografi serif lembut.",
    density: "airy",
    mood: "warm",
    fontFamily: "system",
    headingFontFamily: "lora",
    fontLabel: "Lora + Sistem",
    borderRadiusPx: 8,
    spacingScale: 1.05,
    containerMaxWidthPx: 1180,
    sectionPaddingYPx: 70,
    headerVariant: "centered",
    footerVariant: "columns",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#14532d",
      onPrimary: "#ffffff",
      secondary: "#78350f",
      onSecondary: "#ffffff",
      accent: "#0f5c5c",
      onAccent: "#ffffff",
      surface: "#fdfbf7",
      surfaceMuted: "#f4efe5",
      text: "#1c1917",
      textMuted: "#534b42",
      border: "#e0d6c6",
      ctaBg: "#14532d",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "travel",
    styleVariantKey: "archipelago-blue",
    name: "Archipelago Blue",
    tagline: "Biru samudra & terakota cerah untuk paket wisata domestik & internasional.",
    density: "balanced",
    mood: "light",
    fontFamily: "plus-jakarta-sans",
    fontLabel: "Plus Jakarta Sans",
    borderRadiusPx: 12,
    spacingScale: 1,
    containerMaxWidthPx: 1220,
    sectionPaddingYPx: 60,
    headerVariant: "sticky-cta",
    footerVariant: "columns",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#075985",
      onPrimary: "#ffffff",
      secondary: "#9a3412",
      onSecondary: "#ffffff",
      accent: "#0f766e",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f2f8fc",
      text: "#0f1d28",
      textMuted: "#445a6b",
      border: "#d1e2ee",
      ctaBg: "#075985",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "travel",
    styleVariantKey: "night-voyager",
    name: "Night Voyager",
    tagline: "Latar malam laut dalam dengan sorotan toska & emas untuk paket premium.",
    density: "balanced",
    mood: "dark",
    fontFamily: "poppins",
    fontLabel: "Poppins",
    borderRadiusPx: 10,
    spacingScale: 1,
    containerMaxWidthPx: 1200,
    sectionPaddingYPx: 64,
    headerVariant: "standard",
    footerVariant: "columns",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#2dd4bf",
      onPrimary: "#050505",
      secondary: "#fbbf24",
      onSecondary: "#050505",
      accent: "#38bdf8",
      onAccent: "#050505",
      surface: "#0c1921",
      surfaceMuted: "#152834",
      text: "#f1f5f9",
      textMuted: "#cbd5e1",
      border: "#2a4354",
      ctaBg: "#2dd4bf",
      ctaText: "#050505",
    },
  }),

  // ── 4. CATALOG (4 variants) ───────────────────────────────────────────────
  defineStyleVariant({
    themeId: "catalog",
    styleVariantKey: "clean-gallery",
    name: "Clean Gallery",
    tagline: "Kobalt bersih & grid katalog padat untuk etalase produk ke WhatsApp.",
    density: "compact",
    mood: "light",
    isDefault: true,
    fontFamily: "system",
    fontLabel: "Sistem (Tercepat)",
    borderRadiusPx: 6,
    spacingScale: 1,
    containerMaxWidthPx: 1240,
    sectionPaddingYPx: 56,
    headerVariant: "standard",
    footerVariant: "columns",
    heroVariant: "minimal",
    buttonStyle: "solid",
    colors: {
      primary: "#1d4ed8",
      onPrimary: "#ffffff",
      secondary: "#0f766e",
      onSecondary: "#ffffff",
      accent: "#9a3412",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f7f8fa",
      text: "#111827",
      textMuted: "#4b5563",
      border: "#dde2e8",
      ctaBg: "#1d4ed8",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "catalog",
    styleVariantKey: "craft-minimal",
    name: "Craft Minimal",
    tagline: "Slate tinta & karat hangat untuk furnitur, kriya, dan merek artisan.",
    density: "airy",
    mood: "warm",
    fontFamily: "dm-sans",
    fontLabel: "DM Sans",
    borderRadiusPx: 4,
    spacingScale: 1.05,
    containerMaxWidthPx: 1200,
    sectionPaddingYPx: 64,
    headerVariant: "minimal",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#1e293b",
      onPrimary: "#ffffff",
      secondary: "#9a3412",
      onSecondary: "#ffffff",
      accent: "#155e75",
      onAccent: "#ffffff",
      surface: "#faf9f7",
      surfaceMuted: "#f1eee9",
      text: "#18181b",
      textMuted: "#52525b",
      border: "#ded8cf",
      ctaBg: "#1e293b",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "catalog",
    styleVariantKey: "vibrant-market",
    name: "Vibrant Market",
    tagline: "Ungu modern & hijau zamrud untuk etalase gaya hidup dan grosir cepat.",
    density: "balanced",
    mood: "light",
    fontFamily: "poppins",
    fontLabel: "Poppins",
    borderRadiusPx: 12,
    spacingScale: 1,
    containerMaxWidthPx: 1240,
    sectionPaddingYPx: 56,
    headerVariant: "sticky-cta",
    footerVariant: "columns",
    heroVariant: "minimal",
    buttonStyle: "solid",
    colors: {
      primary: "#6d28d9",
      onPrimary: "#ffffff",
      secondary: "#047857",
      onSecondary: "#ffffff",
      accent: "#b45309",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f8f6fc",
      text: "#171422",
      textMuted: "#524c63",
      border: "#e2dcf0",
      ctaBg: "#6d28d9",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "catalog",
    styleVariantKey: "dark-boutique",
    name: "Dark Boutique",
    tagline: "Latar arang gelap untuk produk elektronik, hobi, dan koleksi edisi khusus.",
    density: "balanced",
    mood: "dark",
    fontFamily: "inter",
    fontLabel: "Inter",
    borderRadiusPx: 8,
    spacingScale: 1,
    containerMaxWidthPx: 1240,
    sectionPaddingYPx: 60,
    headerVariant: "standard",
    footerVariant: "compact",
    heroVariant: "minimal",
    buttonStyle: "solid",
    colors: {
      primary: "#a78bfa",
      onPrimary: "#050505",
      secondary: "#34d399",
      onSecondary: "#050505",
      accent: "#fbbf24",
      onAccent: "#050505",
      surface: "#121216",
      surfaceMuted: "#1e1e26",
      text: "#f4f4f5",
      textMuted: "#d4d4d8",
      border: "#343442",
      ctaBg: "#a78bfa",
      ctaText: "#050505",
    },
  }),

  // ── 5. RESTO (4 variants) ─────────────────────────────────────────────────
  defineStyleVariant({
    themeId: "resto",
    styleVariantKey: "warm-heritage",
    name: "Warm Heritage",
    tagline: "Terakota & hijau rempah hangat untuk restoran keluarga dan multi-cabang.",
    density: "balanced",
    mood: "warm",
    isDefault: true,
    fontFamily: "system",
    fontLabel: "Sistem (Tercepat)",
    borderRadiusPx: 10,
    spacingScale: 1,
    containerMaxWidthPx: 1180,
    sectionPaddingYPx: 60,
    headerVariant: "centered",
    footerVariant: "columns",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#9a3412",
      onPrimary: "#ffffff",
      secondary: "#14532d",
      onSecondary: "#ffffff",
      accent: "#713f12",
      onAccent: "#ffffff",
      surface: "#fffdf9",
      surfaceMuted: "#f7f2ea",
      text: "#1f1712",
      textMuted: "#5c4d42",
      border: "#e5dacb",
      ctaBg: "#9a3412",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "resto",
    styleVariantKey: "kopitiam-classic",
    name: "Kopitiam Classic",
    tagline: "Espreso pekat & hijau giok klasik dengan judul serif untuk kedai kopi & roti.",
    density: "airy",
    mood: "warm",
    fontFamily: "system",
    headingFontFamily: "lora",
    fontLabel: "Lora + Sistem",
    borderRadiusPx: 6,
    spacingScale: 1.05,
    containerMaxWidthPx: 1140,
    sectionPaddingYPx: 68,
    headerVariant: "centered",
    footerVariant: "centered",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#5c2d16",
      onPrimary: "#ffffff",
      secondary: "#0f5c5c",
      onSecondary: "#ffffff",
      accent: "#7c2d12",
      onAccent: "#ffffff",
      surface: "#fbf8f3",
      surfaceMuted: "#f1eae0",
      text: "#1c1510",
      textMuted: "#54473d",
      border: "#dfd4c4",
      ctaBg: "#5c2d16",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "resto",
    styleVariantKey: "fresh-bistro",
    name: "Fresh Bistro",
    tagline: "Hijau zaitun segar & beri gelap untuk katering sehat, kafe, dan gerai modern.",
    density: "balanced",
    mood: "light",
    fontFamily: "plus-jakarta-sans",
    fontLabel: "Plus Jakarta Sans",
    borderRadiusPx: 12,
    spacingScale: 1,
    containerMaxWidthPx: 1180,
    sectionPaddingYPx: 58,
    headerVariant: "standard",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#3f6212",
      onPrimary: "#ffffff",
      secondary: "#881337",
      onSecondary: "#ffffff",
      accent: "#0f5c5c",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f6f8f2",
      text: "#171f10",
      textMuted: "#4b5740",
      border: "#d9e2cd",
      ctaBg: "#3f6212",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "resto",
    styleVariantKey: "charcoal-grill",
    name: "Charcoal Grill",
    tagline: "Permukaan arang hangat dengan aksen bara oranye untuk steakhouse & lounge.",
    density: "balanced",
    mood: "dark",
    fontFamily: "manrope",
    fontLabel: "Manrope",
    borderRadiusPx: 8,
    spacingScale: 1,
    containerMaxWidthPx: 1180,
    sectionPaddingYPx: 62,
    headerVariant: "centered",
    footerVariant: "compact",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#fb923c",
      onPrimary: "#050505",
      secondary: "#4ade80",
      onSecondary: "#050505",
      accent: "#facc15",
      onAccent: "#050505",
      surface: "#171412",
      surfaceMuted: "#26201c",
      text: "#faf7f2",
      textMuted: "#d6cec4",
      border: "#403730",
      ctaBg: "#fb923c",
      ctaText: "#050505",
    },
  }),

  // ── 6. DEALER (4 variants) ────────────────────────────────────────────────
  defineStyleVariant({
    themeId: "dealer",
    styleVariantKey: "precision-slate",
    name: "Precision Slate",
    tagline: "Grafit teknis & merah balap untuk showroom mobil dan motor resmi.",
    density: "compact",
    mood: "light",
    isDefault: true,
    fontFamily: "system",
    fontLabel: "Sistem (Tercepat)",
    borderRadiusPx: 4,
    spacingScale: 1,
    containerMaxWidthPx: 1280,
    sectionPaddingYPx: 56,
    headerVariant: "sticky-cta",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#1e293b",
      onPrimary: "#ffffff",
      secondary: "#b91c1c",
      onSecondary: "#ffffff",
      accent: "#0f4c81",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f4f6f8",
      text: "#0f172a",
      textMuted: "#475569",
      border: "#d6dce4",
      ctaBg: "#b91c1c",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "dealer",
    styleVariantKey: "sport-redline",
    name: "Sport Redline",
    tagline: "Merah performa & baja biru dengan garis tajam untuk unit sport & niaga.",
    density: "compact",
    mood: "light",
    fontFamily: "inter",
    fontLabel: "Inter",
    borderRadiusPx: 2,
    spacingScale: 0.95,
    containerMaxWidthPx: 1280,
    sectionPaddingYPx: 52,
    headerVariant: "sticky-cta",
    footerVariant: "compact",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#991b1b",
      onPrimary: "#ffffff",
      secondary: "#0f4c81",
      onSecondary: "#ffffff",
      accent: "#1e293b",
      onAccent: "#ffffff",
      surface: "#f8fafc",
      surfaceMuted: "#edf1f6",
      text: "#0f172a",
      textMuted: "#475569",
      border: "#cbd5e1",
      ctaBg: "#991b1b",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "dealer",
    styleVariantKey: "executive-fleet",
    name: "Executive Fleet",
    tagline: "Midnight navy & teal tenang untuk armada korporat dan kendaraan listrik.",
    density: "balanced",
    mood: "light",
    fontFamily: "source-sans-3",
    fontLabel: "Source Sans 3",
    borderRadiusPx: 6,
    spacingScale: 1,
    containerMaxWidthPx: 1260,
    sectionPaddingYPx: 60,
    headerVariant: "standard",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#0f172a",
      onPrimary: "#ffffff",
      secondary: "#0f5c5c",
      onSecondary: "#ffffff",
      accent: "#1d4ed8",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f3f6f9",
      text: "#0f172a",
      textMuted: "#475569",
      border: "#d5dde6",
      ctaBg: "#0f5c5c",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "dealer",
    styleVariantKey: "dark-showroom",
    name: "Dark Showroom",
    tagline: "Showroom gelap kontras tinggi yang menonjolkan foto kendaraan & spesifikasi.",
    density: "compact",
    mood: "dark",
    fontFamily: "manrope",
    fontLabel: "Manrope",
    borderRadiusPx: 4,
    spacingScale: 1,
    containerMaxWidthPx: 1280,
    sectionPaddingYPx: 56,
    headerVariant: "sticky-cta",
    footerVariant: "compact",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#f87171",
      onPrimary: "#050505",
      secondary: "#38bdf8",
      onSecondary: "#050505",
      accent: "#fbbf24",
      onAccent: "#050505",
      surface: "#0b1017",
      surfaceMuted: "#161f2c",
      text: "#f8fafc",
      textMuted: "#cbd5e1",
      border: "#2d3c52",
      ctaBg: "#f87171",
      ctaText: "#050505",
    },
  }),
]);

// ---------------------------------------------------------------------------
// Curated `paid_once` Premium Theme Specs & Style Variants
// ---------------------------------------------------------------------------

export const PREMIUM_THEME_CATALOG_SPECS: readonly PremiumThemeCatalogSpec[] = Object.freeze([
  Object.freeze({
    id: "premium-atelier-editorial" as const,
    slug: "atelier-editorial",
    name: "Atelier Editorial Pro",
    tagline: "Editorial arsitektural mewah untuk studio desain, firma hukum, dan konsultan B2B.",
    description:
      "Tema premium beli-sekali dengan bingkai editorial gading & obsidian, tipografi Playfair Display + sistem, kartu portofolio bernomor, serta 2 varian warna terverifikasi WCAG AA.",
    version: "1.0.0",
    schemaVersion: 1 as const,
    tier: "paid_once" as const,
    defaultPriceIdr: 499_000,
    basePlatformThemeId: "compro" as const,
    recommendedOfferingTypes: Object.freeze(["service", "product"] as const),
    highlights: Object.freeze([
      "Tipografi editorial Playfair Display (<= 1 font kustom)",
      "2 varian gaya WCAG AA (Ivory Obsidian & Midnight Atelier)",
      "100% kompatibel dengan seluruh bagian & konten CMS",
    ]),
    previewImagePath: "/themes/premium/atelier-editorial/preview.webp",
  }),
  Object.freeze({
    id: "premium-nusantara-flagship" as const,
    slug: "nusantara-flagship",
    name: "Nusantara Flagship Commerce",
    tagline: "Etalase flagship konversi tinggi untuk merek multi-cabang, travel, dan showroom.",
    description:
      "Tema premium beli-sekali dengan strip kepercayaan terstruktur, sorotan katalog WhatsApp responsif, dan 2 varian warna kontras tinggi (Garuda Gold & Emerald Flagship).",
    version: "1.0.0",
    schemaVersion: 1 as const,
    tier: "paid_once" as const,
    defaultPriceIdr: 699_000,
    basePlatformThemeId: "catalog" as const,
    recommendedOfferingTypes: Object.freeze(["product", "tour", "vehicle", "service"] as const),
    highlights: Object.freeze([
      "Tipografi modern Plus Jakarta Sans (<= 1 font kustom)",
      "2 varian gaya WCAG AA (Garuda Gold & Emerald Flagship)",
      "Konversi cepat WhatsApp & formulir tanpa keranjang belanja",
    ]),
    previewImagePath: "/themes/premium/nusantara-flagship/preview.webp",
  }),
]);

export const PREMIUM_STYLE_VARIANTS: readonly ThemeStyleVariantDefinition[] = Object.freeze([
  defineStyleVariant({
    themeId: "premium-atelier-editorial",
    styleVariantKey: "ivory-obsidian",
    name: "Ivory Obsidian",
    tagline: "Permukaan gading hangat dengan tinta obsidian dan aksen perunggu arsitektural.",
    density: "airy",
    mood: "warm",
    isDefault: true,
    fontFamily: "system",
    headingFontFamily: "playfair-display",
    fontLabel: "Playfair Display + Sistem",
    borderRadiusPx: 2,
    spacingScale: 1.08,
    containerMaxWidthPx: 1200,
    sectionPaddingYPx: 76,
    headerVariant: "minimal",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#1c2434",
      onPrimary: "#ffffff",
      secondary: "#7c3f1d",
      onSecondary: "#ffffff",
      accent: "#0f5257",
      onAccent: "#ffffff",
      surface: "#fbf9f5",
      surfaceMuted: "#f2ede4",
      text: "#15171c",
      textMuted: "#4a4f59",
      border: "#dad2c4",
      ctaBg: "#1c2434",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "premium-atelier-editorial",
    styleVariantKey: "midnight-atelier",
    name: "Midnight Atelier",
    tagline: "Kanvas gelap galeri dengan aksen sampanye emas lembut kontras tinggi.",
    density: "airy",
    mood: "dark",
    fontFamily: "system",
    headingFontFamily: "playfair-display",
    fontLabel: "Playfair Display + Sistem",
    borderRadiusPx: 2,
    spacingScale: 1.08,
    containerMaxWidthPx: 1200,
    sectionPaddingYPx: 76,
    headerVariant: "minimal",
    footerVariant: "compact",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#e5c07b",
      onPrimary: "#050505",
      secondary: "#7dd3fc",
      onSecondary: "#050505",
      accent: "#6ee7b7",
      onAccent: "#050505",
      surface: "#10131a",
      surfaceMuted: "#1a1f2b",
      text: "#f8f7f4",
      textMuted: "#cbd5e1",
      border: "#323a4d",
      ctaBg: "#e5c07b",
      ctaText: "#050505",
    },
  }),
  defineStyleVariant({
    themeId: "premium-nusantara-flagship",
    styleVariantKey: "garuda-gold",
    name: "Garuda Gold",
    tagline: "Merah marun elegan & emas tua berwibawa untuk merek flagship Indonesia.",
    density: "balanced",
    mood: "light",
    isDefault: true,
    fontFamily: "plus-jakarta-sans",
    fontLabel: "Plus Jakarta Sans",
    borderRadiusPx: 8,
    spacingScale: 1,
    containerMaxWidthPx: 1240,
    sectionPaddingYPx: 64,
    headerVariant: "sticky-cta",
    footerVariant: "columns",
    heroVariant: "banner",
    buttonStyle: "solid",
    colors: {
      primary: "#7f1d1d",
      onPrimary: "#ffffff",
      secondary: "#78350f",
      onSecondary: "#ffffff",
      accent: "#1e3a5f",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#faf7f4",
      text: "#181414",
      textMuted: "#544949",
      border: "#e5d9d3",
      ctaBg: "#7f1d1d",
      ctaText: "#ffffff",
    },
  }),
  defineStyleVariant({
    themeId: "premium-nusantara-flagship",
    styleVariantKey: "emerald-flagship",
    name: "Emerald Flagship",
    tagline: "Zamrud dalam & biru samudra dengan ritme kartu konversi cepat.",
    density: "balanced",
    mood: "light",
    fontFamily: "plus-jakarta-sans",
    fontLabel: "Plus Jakarta Sans",
    borderRadiusPx: 10,
    spacingScale: 1,
    containerMaxWidthPx: 1240,
    sectionPaddingYPx: 64,
    headerVariant: "sticky-cta",
    footerVariant: "columns",
    heroVariant: "split",
    buttonStyle: "solid",
    colors: {
      primary: "#065f46",
      onPrimary: "#ffffff",
      secondary: "#0c4a6e",
      onSecondary: "#ffffff",
      accent: "#9a3412",
      onAccent: "#ffffff",
      surface: "#ffffff",
      surfaceMuted: "#f2f8f6",
      text: "#0e1d19",
      textMuted: "#415750",
      border: "#cfe2dc",
      ctaBg: "#065f46",
      ctaText: "#ffffff",
    },
  }),
]);

export const ALL_STYLE_VARIANTS: readonly ThemeStyleVariantDefinition[] = Object.freeze([
  ...BUILTIN_STYLE_VARIANTS,
  ...PREMIUM_STYLE_VARIANTS,
]);

const VARIANTS_BY_THEME_MAP: ReadonlyMap<string, readonly ThemeStyleVariantDefinition[]> = (() => {
  const map = new Map<string, ThemeStyleVariantDefinition[]>();
  for (const variant of ALL_STYLE_VARIANTS) {
    const existing = map.get(variant.themeId) ?? [];
    existing.push(variant);
    map.set(variant.themeId, existing);
  }
  const frozen = new Map<string, readonly ThemeStyleVariantDefinition[]>();
  for (const [k, list] of map.entries()) {
    frozen.set(k, Object.freeze(list));
  }
  return frozen;
})();

export function getStyleVariantsForTheme(themeId: string): readonly ThemeStyleVariantDefinition[] {
  return VARIANTS_BY_THEME_MAP.get(themeId.trim()) ?? [];
}

export function getDefaultStyleVariantForTheme(
  themeId: string,
): ThemeStyleVariantDefinition | null {
  const list = getStyleVariantsForTheme(themeId);
  return list.find((v) => v.isDefault) ?? list[0] ?? null;
}

export function getStyleVariantById(
  themeId: string,
  variantKeyOrId: string,
): ThemeStyleVariantDefinition | null {
  const key = variantKeyOrId.trim();
  if (!key || hasDangerousCssSyntax(key)) return null;
  const list = getStyleVariantsForTheme(themeId);
  if (key === "default") {
    return getDefaultStyleVariantForTheme(themeId);
  }
  return list.find((v) => v.styleVariantKey === key || v.id === key) ?? null;
}

export function getPremiumThemeCatalogSpec(themeId: string): PremiumThemeCatalogSpec | null {
  const clean = themeId.trim();
  return PREMIUM_THEME_CATALOG_SPECS.find((item) => item.id === clean || item.slug === clean) ?? null;
}

export function isPremiumThemeId(themeId: string): themeId is PremiumThemeId {
  return (PREMIUM_THEME_IDS as readonly string[]).includes(themeId);
}

export function isPlatformThemeId(themeId: string): themeId is PlatformThemeId {
  return (PLATFORM_THEME_IDS as readonly string[]).includes(themeId);
}

/**
 * Emits a guaranteed-safe CSS custom property block for any Style Variant (including dark variants).
 */
export function renderStyleVariantCssVariables(variant: ThemeStyleVariantDefinition): string {
  const c = variant.colors;
  const bodyFont: AllowedThemeFont = variant.tokens.fastestSystemFont
    ? "system"
    : variant.tokens.fontFamily;
  const headingFont: AllowedThemeFont = variant.tokens.fastestSystemFont
    ? "system"
    : (variant.tokens.headingFontFamily ?? variant.tokens.fontFamily);

  const declarations = [
    `--ps-brand-primary: ${sanitizeThemeColor(c.primary)}`,
    `--ps-brand-on-primary: ${sanitizeThemeColor(c.onPrimary)}`,
    `--ps-brand-secondary: ${sanitizeThemeColor(c.secondary)}`,
    `--ps-brand-on-secondary: ${sanitizeThemeColor(c.onSecondary)}`,
    `--ps-brand-accent: ${sanitizeThemeColor(c.accent)}`,
    `--ps-brand-on-accent: ${sanitizeThemeColor(c.onAccent)}`,
    `--ps-surface: ${sanitizeThemeColor(c.surface)}`,
    `--ps-surface-muted: ${sanitizeThemeColor(c.surfaceMuted)}`,
    `--ps-ink: ${sanitizeThemeColor(c.text)}`,
    `--ps-ink-muted: ${sanitizeThemeColor(c.textMuted)}`,
    `--ps-border: ${sanitizeThemeColor(c.border)}`,
    `--ps-cta-bg: ${sanitizeThemeColor(c.ctaBg)}`,
    `--ps-cta-text: ${sanitizeThemeColor(c.ctaText)}`,
    `--ps-color-primary: ${sanitizeThemeColor(c.primary)}`,
    `--ps-color-secondary: ${sanitizeThemeColor(c.secondary)}`,
    `--ps-color-accent: ${sanitizeThemeColor(c.accent)}`,
    `--ps-color-surface: ${sanitizeThemeColor(c.surface)}`,
    `--ps-color-text: ${sanitizeThemeColor(c.text)}`,
    `--ps-font-body: ${THEME_FONT_STACKS[bodyFont]}`,
    `--ps-font-heading: ${THEME_FONT_STACKS[headingFont]}`,
    `--ps-radius: ${variant.tokens.borderRadiusPx}px`,
    `--ps-radius-base: ${variant.tokens.borderRadiusPx}px`,
    `--ps-spacing-scale: ${Number(variant.tokens.spacingScale.toFixed(3))}`,
    `--ps-container-max-width: ${variant.tokens.containerMaxWidthPx}px`,
    `--ps-section-padding-y: ${variant.tokens.sectionPaddingYPx}px`,
  ];

  return `:root { ${declarations.join("; ")}; }`;
}

// ---------------------------------------------------------------------------
// Lossless Style Variant / Theme Content Preservation Helper
// ---------------------------------------------------------------------------

export interface TenantContentStateSnapshot<
  TPage = unknown,
  TPost = unknown,
  TOffering = unknown,
> {
  readonly themeId: string;
  readonly styleVariantId: string;
  readonly pages: readonly TPage[];
  readonly posts: readonly TPost[];
  readonly offerings: readonly TOffering[];
}

export interface LosslessVariantSwitchResult<
  TPage = unknown,
  TPost = unknown,
  TOffering = unknown,
> {
  readonly previousThemeId: string;
  readonly nextThemeId: string;
  readonly previousStyleVariantId: string;
  readonly nextStyleVariantId: string;
  readonly appliedVariant: ThemeStyleVariantDefinition;
  readonly contentPreserved: true;
  readonly pages: readonly TPage[];
  readonly posts: readonly TPost[];
  readonly offerings: readonly TOffering[];
}

/**
 * Pure lossless switch proof: swaps only presentation theme/style-variant metadata
 * while returning the exact unmutated pages, posts, and offerings arrays.
 */
export function switchThemeVariantLosslessly<TPage, TPost, TOffering>(
  current: TenantContentStateSnapshot<TPage, TPost, TOffering>,
  target: { readonly themeId: string; readonly styleVariantId: string },
): LosslessVariantSwitchResult<TPage, TPost, TOffering> {
  const variant = getStyleVariantById(target.themeId, target.styleVariantId);
  if (!variant) {
    throw new ThemeStoreDomainError(
      422,
      "THEME_VARIANT_NOT_FOUND",
      `Varian gaya "${target.styleVariantId}" tidak ditemukan untuk tema "${target.themeId}".`,
      [
        {
          field: "styleVariantId",
          code: "THEME_VARIANT_NOT_FOUND",
          message: `Unknown style variant "${target.styleVariantId}" for theme "${target.themeId}".`,
        },
      ],
    );
  }

  return {
    previousThemeId: current.themeId,
    nextThemeId: variant.themeId,
    previousStyleVariantId: current.styleVariantId,
    nextStyleVariantId: variant.styleVariantKey,
    appliedVariant: variant,
    contentPreserved: true,
    pages: current.pages,
    posts: current.posts,
    offerings: current.offerings,
  };
}

// ---------------------------------------------------------------------------
// Commercial Theme Store Pricing & Single-Coupon Math (Server-Authoritative!)
// ---------------------------------------------------------------------------

export const THEME_STORE_FORBIDDEN_PRICE_KEYS: ReadonlySet<string> = new Set([
  "price",
  "priceIdr",
  "price_idr",
  "basePriceIdr",
  "base_price_idr",
  "amount",
  "amountIdr",
  "amount_idr",
  "discount",
  "discountIdr",
  "discountAmountIdr",
  "discount_amount_idr",
  "channelFeeIdr",
  "channel_fee_idr",
  "totalPayableIdr",
  "total_payable_idr",
  "totalAmountIdr",
  "total_amount_idr",
  "netBaseAmountIdr",
  "net_base_amount_idr",
]);

export const THEME_STORE_CHANNEL_FEES_IDR: Readonly<Record<string, number>> = Object.freeze({
  QRIS: 0,
  VA_BCA: 4_000,
  VA_BNI: 4_000,
  VA_BRI: 4_000,
  VA_MANDIRI: 4_000,
  VA_PERMATA: 4_000,
});

export const ALLOWED_THEME_STORE_CHANNELS = [
  "QRIS",
  "VA_BCA",
  "VA_BNI",
  "VA_BRI",
  "VA_MANDIRI",
  "VA_PERMATA",
] as const;
export type ThemeStoreChannelCode = (typeof ALLOWED_THEME_STORE_CHANNELS)[number];

export interface ThemeStoreCouponInput {
  readonly id: string;
  readonly code: string;
  readonly discountKind: CouponDiscountKind;
  readonly discountValue: number;
  readonly eligiblePayerTypes?: readonly CouponPayerType[];
  readonly maxRedemptions: number | null;
  readonly redeemedCount: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly active: boolean;
}

export interface ComputeThemeStoreQuoteInput {
  readonly themeId: string;
  readonly catalogPriceIdr: number;
  readonly channelCode: string;
  readonly payerType: CouponPayerType;
  readonly coupon?: ThemeStoreCouponInput | PromoCouponRecord | null;
  readonly rawCouponCode?: unknown;
  readonly alreadyRedeemedByTenant?: boolean;
  readonly nowMs: number;
}

export interface ThemeStoreCheckoutQuote {
  readonly themeId: string;
  readonly currency: typeof BILLING_CURRENCY;
  readonly basePriceIdr: number;
  readonly discountAmountIdr: number;
  readonly netBaseAmountIdr: number;
  readonly channelCode: ThemeStoreChannelCode;
  readonly channelFeeIdr: number;
  readonly totalPayableIdr: number;
  readonly couponId: string | null;
  readonly couponCode: string | null;
  readonly nonPkpNotice: string;
}

export function normalizeThemeStoreChannelCode(raw: unknown): ThemeStoreChannelCode {
  if (typeof raw !== "string" || !raw.trim()) {
    return "QRIS";
  }
  const upper = raw.trim().toUpperCase();
  if ((ALLOWED_THEME_STORE_CHANNELS as readonly string[]).includes(upper)) {
    return upper as ThemeStoreChannelCode;
  }
  throw new BillingValidationError(
    "INVALID_PAYMENT_CHANNEL",
    `Saluran pembayaran "${raw}" tidak didukung. Pilih QRIS atau Virtual Account bank yang tersedia.`,
    [{ field: "channelCode", code: "INVALID_PAYMENT_CHANNEL", message: "Unsupported payment channel." }],
  );
}

/**
 * Pure server-side pricing & single-coupon calculation for `paid_once` Theme Store checkout.
 * Guarantees exact integer IDR arithmetic, single-coupon enforcement, and AutoLaris floor (`>= Rp 10.000`).
 */
export function computeThemeStoreCheckoutQuote(
  input: ComputeThemeStoreQuoteInput,
): ThemeStoreCheckoutQuote {
  const basePriceIdr = assertExactIdrInteger(input.catalogPriceIdr, "catalogPriceIdr", {
    min: MIN_AUTOLARIS_CHARGE_IDR,
    max: MAX_IDR_AMOUNT,
  });
  const channelCode = normalizeThemeStoreChannelCode(input.channelCode);
  const channelFeeIdr = THEME_STORE_CHANNEL_FEES_IDR[channelCode] ?? 0;

  let normalizedCode: string | null = null;
  if (input.rawCouponCode !== undefined && input.rawCouponCode !== null) {
    normalizedCode = parseSingleCouponCodeInput(input.rawCouponCode);
  }

  let discountAmountIdr = 0;
  let couponId: string | null = null;
  let couponCode: string | null = null;

  if (normalizedCode !== null || input.coupon) {
    const coupon = input.coupon;
    if (!coupon) {
      throw new BillingValidationError(
        "COUPON_NOT_FOUND",
        `Kode kupon "${normalizedCode}" tidak ditemukan.`,
        [{ field: "couponCode", code: "COUPON_NOT_FOUND", message: "Coupon code was not found." }],
      );
    }

    if (!coupon.active) {
      throw new BillingValidationError("COUPON_INACTIVE", `Kupon "${coupon.code}" sudah tidak aktif.`);
    }
    if (input.nowMs < coupon.startsAtMs) {
      throw new BillingValidationError("COUPON_NOT_STARTED", `Kupon "${coupon.code}" belum berlaku.`);
    }
    if (input.nowMs > coupon.endsAtMs) {
      throw new BillingValidationError("COUPON_EXPIRED", `Kupon "${coupon.code}" sudah kedaluwarsa.`);
    }
    if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
      throw new BillingValidationError("COUPON_EXHAUSTED", `Kuota kupon "${coupon.code}" sudah habis.`);
    }
    if (input.alreadyRedeemedByTenant) {
      throw new BillingValidationError(
        "COUPON_ALREADY_REDEEMED",
        `Kupon "${coupon.code}" sudah pernah digunakan oleh situs ini.`,
      );
    }
    const eligiblePayers = coupon.eligiblePayerTypes ?? ["tenant", "agency"];
    if (!eligiblePayers.includes(input.payerType)) {
      throw new BillingValidationError(
        "COUPON_PAYER_INELIGIBLE",
        `Kupon "${coupon.code}" tidak berlaku untuk jenis pembayar ini.`,
      );
    }

    if (coupon.discountKind === "percent") {
      const pct = assertExactIdrInteger(coupon.discountValue, "discountValue", { min: 1, max: 100 });
      discountAmountIdr = Number((BigInt(basePriceIdr) * BigInt(pct)) / 100n);
    } else {
      const fixed = assertExactIdrInteger(coupon.discountValue, "discountValue", {
        min: 1,
        max: MAX_IDR_AMOUNT,
      });
      discountAmountIdr = Math.min(basePriceIdr, fixed);
    }

    const candidateNet = basePriceIdr - discountAmountIdr;
    if (candidateNet < AUTOLARIS_MIN_PAYMENT_IDR) {
      throw new BillingValidationError(
        "COUPON_BELOW_MIN_PAYMENT_FLOOR",
        `Diskon kupon menyebabkan nominal bersih (${formatIdrDisplay(candidateNet)}) di bawah batas minimum pembayaran AutoLaris (${formatIdrDisplay(AUTOLARIS_MIN_PAYMENT_IDR)}).`,
      );
    }

    couponId = coupon.id;
    couponCode = coupon.code;
  }

  const netBaseAmountIdr = basePriceIdr - discountAmountIdr;
  const totalPayableIdr = netBaseAmountIdr + channelFeeIdr;

  return {
    themeId: input.themeId,
    currency: BILLING_CURRENCY,
    basePriceIdr,
    discountAmountIdr,
    netBaseAmountIdr,
    channelCode,
    channelFeeIdr,
    totalPayableIdr,
    couponId,
    couponCode,
    nonPkpNotice: RECEIPT_NON_PKP_NOTICE,
  };
}

// ---------------------------------------------------------------------------
// Numbered Theme Store PDF Receipt Builder (`INV-THM-YYYY-NNNNNN`)
// ---------------------------------------------------------------------------

export const THEME_RECEIPT_NUMBER_PATTERN = /^INV-THM-(\d{4})-(\d{6,})$/;

export function formatThemeReceiptNumber(year: number, sequence: number): string {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) {
    throw new BillingValidationError("INVALID_RECEIPT_YEAR", "Tahun kuitansi tema tidak valid.");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new BillingValidationError(
      "INVALID_RECEIPT_SEQUENCE",
      "Nomor urut kuitansi tema harus bilangan bulat positif.",
    );
  }
  return `INV-THM-${year}-${String(sequence).padStart(6, "0")}`;
}

export function buildThemeReceiptR2ObjectKey(year: number, receiptNumber: string): string {
  const clean = receiptNumber.trim();
  if (!THEME_RECEIPT_NUMBER_PATTERN.test(clean)) {
    throw new BillingValidationError(
      "INVALID_RECEIPT_NUMBER",
      `Format nomor kuitansi tema "${clean}" tidak valid (harus INV-THM-YYYY-NNNNNN).`,
    );
  }
  return `platform/theme-receipts/${year}/${clean}.pdf`;
}

export interface ThemeStoreReceiptPdfInput {
  readonly receiptNumber: string;
  readonly issuedAtMs: number;
  readonly tenantName: string;
  readonly tenantHandle: string;
  readonly payerName: string;
  readonly themeId: string;
  readonly themeName: string;
  readonly orderId: string;
  readonly baseAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly couponCode?: string | null;
  readonly paymentChannel: string;
  readonly providerReference?: string | null;
  readonly nonPkpNotice?: string;
}

export interface GeneratedThemeStoreReceiptPdf {
  readonly bytes: Uint8Array;
  readonly sha256Hex: string;
  readonly byteLength: number;
  readonly receiptNumber: string;
  readonly r2ObjectKey: string;
  readonly nonPkpNotice: string;
  readonly headerSignature: string;
}

function toAsciiSafePdfText(raw: string): string {
  return (
    raw
      .replace(/[\u2013\u2014\u2212]/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "-"
  );
}

function drawRightText(
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
): void {
  const safe = toAsciiSafePdfText(text);
  const width = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: rightX - width, y, size, font, color });
}

/**
 * Generates a deterministic, structurally valid `%PDF-1.4` / `pdf-lib` numbered receipt
 * (`INV-THM-YYYY-NNNNNN`) for a settled commercial `paid_once` theme purchase.
 */
export async function generateThemeStoreReceiptPdf(
  input: ThemeStoreReceiptPdfInput,
): Promise<GeneratedThemeStoreReceiptPdf> {
  const receiptNumber = input.receiptNumber.trim();
  if (!THEME_RECEIPT_NUMBER_PATTERN.test(receiptNumber)) {
    throw new BillingValidationError(
      "INVALID_RECEIPT_NUMBER",
      `Format nomor kuitansi tema "${receiptNumber}" tidak valid (harus INV-THM-YYYY-NNNNNN).`,
    );
  }

  const baseAmountIdr = assertExactIdrInteger(input.baseAmountIdr, "baseAmountIdr");
  const discountAmountIdr = assertExactIdrInteger(input.discountAmountIdr, "discountAmountIdr");
  const channelFeeIdr = assertExactIdrInteger(input.channelFeeIdr, "channelFeeIdr");
  const totalAmountIdr = assertExactIdrInteger(input.totalAmountIdr, "totalAmountIdr");

  if (baseAmountIdr - discountAmountIdr + channelFeeIdr !== totalAmountIdr) {
    throw new BillingValidationError(
      "RECEIPT_AMOUNT_MISMATCH",
      "Rincian nominal kuitansi tema tidak konsisten.",
    );
  }

  const issuedAtMs = Math.trunc(input.issuedAtMs);
  const year = getWibYearFromEpochMs(issuedAtMs);
  const r2ObjectKey = buildThemeReceiptR2ObjectKey(year, receiptNumber);
  const nonPkpNotice = input.nonPkpNotice?.trim() || RECEIPT_NON_PKP_NOTICE;

  const pdfDoc = await PDFDocument.create();
  const issuedDate = new Date(issuedAtMs);
  pdfDoc.setTitle(`KUITANSI TEMA PREMIUM ${receiptNumber}`);
  pdfDoc.setSubject(`Bukti Pembayaran Tema ${input.themeName} (${input.tenantHandle})`);
  pdfDoc.setAuthor("PunyaSitus");
  pdfDoc.setProducer("PunyaSitus Commercial Theme Store (pdf-lib)");
  pdfDoc.setCreator("PunyaSitus");
  pdfDoc.setKeywords([receiptNumber, input.themeId, input.tenantHandle, "paid_once", "non-PKP"]);
  pdfDoc.setCreationDate(issuedDate);
  pdfDoc.setModificationDate(issuedDate);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 48;
  const rightX = pageWidth - marginX;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const inkDark = rgb(0.07, 0.11, 0.14);
  const inkMuted = rgb(0.35, 0.42, 0.48);
  const brandDark = rgb(0.09, 0.42, 0.32); // #176b51
  const border = rgb(0.85, 0.89, 0.87);
  const white = rgb(1, 1, 1);

  // Header band
  page.drawRectangle({
    x: 0,
    y: pageHeight - 86,
    width: pageWidth,
    height: 86,
    color: brandDark,
  });

  page.drawText("PunyaSitus", {
    x: marginX,
    y: pageHeight - 38,
    size: 20,
    font: fontBold,
    color: white,
  });
  page.drawText("Platform Website Bisnis Indonesia (punyasitus.com)", {
    x: marginX,
    y: pageHeight - 56,
    size: 9,
    font: fontRegular,
    color: rgb(0.88, 0.96, 0.93),
  });

  drawRightText(page, "KUITANSI TEMA PREMIUM", rightX, pageHeight - 36, fontBold, 13, white);
  drawRightText(page, `No. ${receiptNumber}`, rightX, pageHeight - 54, fontBold, 11, white);
  drawRightText(
    page,
    `Terbit: ${formatWibDateTime(issuedAtMs)}`,
    rightX,
    pageHeight - 69,
    fontRegular,
    8.5,
    rgb(0.88, 0.96, 0.93),
  );

  let y = pageHeight - 122;
  const drawRow = (label: string, value: string, bold = false): void => {
    page.drawText(toAsciiSafePdfText(label), {
      x: marginX,
      y,
      size: 10,
      font: bold ? fontBold : fontRegular,
      color: bold ? inkDark : inkMuted,
    });
    drawRightText(page, value, rightX, y, bold ? fontBold : fontRegular, 10, inkDark);
    y -= 20;
  };

  drawRow("Website / Tenant", `${input.tenantName} (${input.tenantHandle})`, true);
  drawRow("Pembayar", input.payerName);
  drawRow("ID Pesanan", input.orderId);
  drawRow("Lisensi Tema", `${input.themeName} (${input.themeId}) - Lisensi Per-Website`);
  drawRow("Metode Pembayaran", input.paymentChannel);
  drawRow("Referensi Provider", input.providerReference ?? "-");

  y -= 8;
  page.drawLine({
    start: { x: marginX, y },
    end: { x: rightX, y },
    thickness: 1,
    color: border,
  });
  y -= 24;

  drawRow("Harga Tema (Beli Sekali)", formatIdrDisplay(baseAmountIdr));
  if (discountAmountIdr > 0) {
    drawRow(
      input.couponCode ? `Diskon Kupon (${input.couponCode})` : "Diskon Kupon",
      `-${formatIdrDisplay(discountAmountIdr)}`,
    );
  }
  drawRow("Biaya Saluran Pembayaran", formatIdrDisplay(channelFeeIdr));
  y -= 4;
  page.drawLine({
    start: { x: marginX, y },
    end: { x: rightX, y },
    thickness: 1,
    color: border,
  });
  y -= 22;
  drawRow("TOTAL DIBAYAR (LUNAS)", formatIdrDisplay(totalAmountIdr), true);

  y -= 24;
  page.drawText(toAsciiSafePdfText(nonPkpNotice), {
    x: marginX,
    y,
    size: 8.5,
    font: fontRegular,
    color: inkMuted,
  });

  const savedBytes = await pdfDoc.save({ useObjectStreams: false });
  const bytes = new Uint8Array(savedBytes);
  // Normalize PDF version header to %PDF-1.4 for maximum viewer & verification parity
  if (bytes.length >= 8 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    bytes[5] = 0x31; // '1'
    bytes[6] = 0x2e; // '.'
    bytes[7] = 0x34; // '4'
  }
  const sha256Hex = await computeSha256Hex(bytes);
  const headerSignature = new TextDecoder().decode(bytes.slice(0, 8));

  return {
    bytes,
    sha256Hex,
    byteLength: bytes.byteLength,
    receiptNumber,
    r2ObjectKey,
    nonPkpNotice,
    headerSignature,
  };
}

export async function isThemeStoreReceiptPdfValid(bytes: Uint8Array): Promise<boolean> {
  if (bytes.byteLength < 64) return false;
  const head = new TextDecoder().decode(bytes.slice(0, 8));
  if (!head.startsWith("%PDF-1.")) return false;
  try {
    const doc = await PDFDocument.load(bytes);
    return doc.getPageCount() >= 1;
  } catch {
    return false;
  }
}
