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
 * Curated `paid_once` Premium Theme Manifest: `premium-atelier-editorial`
 * (REQ-096, REQ-020, REQ-040; ADR-0010; PLAN §11.4 & §19.7; DESIGN.md §7; TASK-096).
 *
 * Pure presentation manifest:
 * - Zero DB, auth, Worker binding, Node runtime, or admin/Base UI imports.
 * - Zero arbitrary CSS/JS injection and zero `.zip` runtime loading.
 * - <= 1 custom font (`playfair-display` with system body fallback).
 * - All variants WCAG 2.1 AA >= 4.5:1 verified.
 */

export const ATELIER_EDITORIAL_THEME_ID = "premium-atelier-editorial" as const;

export const ATELIER_EDITORIAL_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

export const ATELIER_EDITORIAL_STYLE_VARIANTS: readonly ThemeStyleVariantDefinition[] =
  getStyleVariantsForTheme(ATELIER_EDITORIAL_THEME_ID);

const DEFAULT_VARIANT = getDefaultStyleVariantForTheme(ATELIER_EDITORIAL_THEME_ID)!;

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse(DEFAULT_VARIANT.tokens);
const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse(DEFAULT_VARIANT.variants);

export const ATELIER_EDITORIAL_THEME_MANIFEST = Object.freeze({
  id: ATELIER_EDITORIAL_THEME_ID,
  slug: "atelier-editorial" as const,
  name: "Atelier Editorial Pro",
  tagline: "Editorial arsitektural mewah untuk studio desain, firma hukum, dan konsultan B2B.",
  description:
    "Tema premium beli-sekali dengan bingkai editorial gading & obsidian, tipografi Playfair Display + sistem, kartu portofolio bernomor, serta 2 varian warna terverifikasi WCAG AA.",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "paid_once" as const,
  priceIdr: 499_000 as const,
  basePlatformThemeId: "compro" as const,
  recommendedOfferingTypes: ["service", "product"] as readonly OfferingType[],
  supportedRoutes: ATELIER_EDITORIAL_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  styleVariants: ATELIER_EDITORIAL_STYLE_VARIANTS,
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  palette: Object.freeze({
    surface: DEFAULT_VARIANT.colors.surface,
    surfaceMuted: DEFAULT_VARIANT.colors.surfaceMuted,
    ink: DEFAULT_VARIANT.colors.text,
    inkMuted: DEFAULT_VARIANT.colors.textMuted,
    border: DEFAULT_VARIANT.colors.border,
  }),
  previewImagePath: "/themes/premium/atelier-editorial/preview.webp",
});
