import type { OfferingType } from "@punyasitus/core/schemas/common";
import {
  CLOSED_SECTION_TYPES,
  ThemeTokensSchema,
  ThemeVariantsSchema,
  validateThemeConfigSnapshot,
  type ClosedSectionType,
  type ThemeConfigSnapshot,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import {
  getStyleVariantsForTheme,
  type ThemeStyleVariantDefinition,
} from "@punyasitus/core/theme/variants";

/**
 * Platform Theme Manifest: `catalog` — Product Showcase Catalog -> Closing via WhatsApp
 * (REQ-018, REQ-020, REQ-093, PLAN §7.3 & §19.8, DESIGN.md §7, TASK-093).
 */

export const CATALOG_THEME_ID = "catalog" as const;

export const CATALOG_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse({
  primaryColor: "#1d4ed8",
  secondaryColor: "#0f766e",
  accentColor: "#b45309",
  surfaceColor: "#ffffff",
  textColor: "#111827",
  fontFamily: "system",
  borderRadiusPx: 6,
  spacingScale: 1,
  containerMaxWidthPx: 1240,
  sectionPaddingYPx: 56,
  fastestSystemFont: false,
});

const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse({
  styleVariant: "default",
  headerVariant: "standard",
  footerVariant: "columns",
  heroVariant: "minimal",
  buttonStyle: "solid",
});

export function validateCatalogPresentationConfig(input: unknown): ThemeConfigSnapshot {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const tokens =
    raw.tokens && typeof raw.tokens === "object" && !Array.isArray(raw.tokens)
      ? { ...DEFAULT_TOKENS, ...(raw.tokens as Record<string, unknown>) }
      : { ...DEFAULT_TOKENS };
  const variants =
    raw.variants && typeof raw.variants === "object" && !Array.isArray(raw.variants)
      ? { ...DEFAULT_VARIANTS, ...(raw.variants as Record<string, unknown>) }
      : { ...DEFAULT_VARIANTS };
  return validateThemeConfigSnapshot({
    themeId: CATALOG_THEME_ID,
    tokens,
    variants,
  });
}

export const CATALOG_THEME_MANIFEST = Object.freeze({
  id: CATALOG_THEME_ID,
  name: "Product Showcase Catalog",
  tagline: "Etalase katalog produk rapi untuk ecer, custom & grosir langsung ke WhatsApp.",
  description:
    "Grid produk 3 kolom desktop yang ringkas dan mudah dipindai, harga tetap/rentang/nego, spesifikasi material, serta CTA WhatsApp kontekstual tanpa keranjang belanja.",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "included" as const,
  recommendedBlueprintIds: ["wa_catalog_showcase"] as const,
  recommendedOfferingTypes: ["product", "service"] as readonly OfferingType[],
  supportedRoutes: CATALOG_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  styleVariants: getStyleVariantsForTheme(CATALOG_THEME_ID) as readonly ThemeStyleVariantDefinition[],
  palette: Object.freeze({
    surface: "#ffffff",
    surfaceMuted: "#f7f8fa",
    ink: "#111827",
    inkMuted: "#4b5563",
    border: "#dde2e8",
  }),
  validatePresentationConfig: validateCatalogPresentationConfig,
});
