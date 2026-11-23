import type { OfferingType } from "@punyasitus/core/schemas/common";
import {
  CLOSED_SECTION_TYPES,
  ThemeTokensSchema,
  ThemeVariantsSchema,
  type ClosedSectionType,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import {
  getDefaultStyleVariantForTheme,
  getStyleVariantsForTheme,
  type ThemeStyleVariantDefinition,
} from "@punyasitus/core/theme/variants";

/**
 * Curated `paid_once` Premium Theme Manifest: `premium-nusantara-flagship`
 * (REQ-096, REQ-020, REQ-040; ADR-0010; PLAN §11.4 & §19.7; DESIGN.md §7; TASK-096).
 *
 * Pure presentation manifest:
 * - Zero DB, auth, Worker binding, Node runtime, or admin/Base UI imports.
 * - Zero arbitrary CSS/JS injection and zero `.zip` runtime loading.
 * - <= 1 custom font (`plus-jakarta-sans` with system fallback).
 * - All variants WCAG 2.1 AA >= 4.5:1 verified.
 */

export const NUSANTARA_FLAGSHIP_THEME_ID = "premium-nusantara-flagship" as const;

export const NUSANTARA_FLAGSHIP_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

export const NUSANTARA_FLAGSHIP_STYLE_VARIANTS: readonly ThemeStyleVariantDefinition[] =
  getStyleVariantsForTheme(NUSANTARA_FLAGSHIP_THEME_ID);

const DEFAULT_VARIANT = getDefaultStyleVariantForTheme(NUSANTARA_FLAGSHIP_THEME_ID)!;

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse(DEFAULT_VARIANT.tokens);
const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse(DEFAULT_VARIANT.variants);

export const NUSANTARA_FLAGSHIP_THEME_MANIFEST = Object.freeze({
  id: NUSANTARA_FLAGSHIP_THEME_ID,
  slug: "nusantara-flagship" as const,
  name: "Nusantara Flagship Commerce",
  tagline: "Etalase flagship konversi tinggi untuk merek multi-cabang, travel, dan showroom.",
  description:
    "Tema premium beli-sekali dengan strip kepercayaan terstruktur, sorotan katalog WhatsApp responsif, dan 2 varian warna kontras tinggi (Garuda Gold & Emerald Flagship).",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "paid_once" as const,
  priceIdr: 699_000 as const,
  basePlatformThemeId: "catalog" as const,
  recommendedOfferingTypes: ["product", "tour", "vehicle", "service"] as readonly OfferingType[],
  supportedRoutes: NUSANTARA_FLAGSHIP_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  styleVariants: NUSANTARA_FLAGSHIP_STYLE_VARIANTS,
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  palette: Object.freeze({
    surface: DEFAULT_VARIANT.colors.surface,
    surfaceMuted: DEFAULT_VARIANT.colors.surfaceMuted,
    ink: DEFAULT_VARIANT.colors.text,
    inkMuted: DEFAULT_VARIANT.colors.textMuted,
    border: DEFAULT_VARIANT.colors.border,
  }),
  previewImagePath: "/themes/premium/nusantara-flagship/preview.webp",
});
