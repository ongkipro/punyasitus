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
 * Platform Theme Manifest: `dealer` — Automotive & Vehicle Showroom
 * (REQ-018, REQ-020, REQ-079, REQ-093, PLAN §7.3 & §19.8, DESIGN.md §7, TASK-093).
 */

export const DEALER_THEME_ID = "dealer" as const;

export const DEALER_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse({
  primaryColor: "#1e293b",
  secondaryColor: "#b91c1c",
  accentColor: "#0f4c81",
  surfaceColor: "#ffffff",
  textColor: "#0f172a",
  fontFamily: "system",
  borderRadiusPx: 4,
  spacingScale: 1,
  containerMaxWidthPx: 1280,
  sectionPaddingYPx: 56,
  fastestSystemFont: false,
});

const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse({
  styleVariant: "default",
  headerVariant: "sticky-cta",
  footerVariant: "columns",
  heroVariant: "split",
  buttonStyle: "solid",
});

export function validateDealerPresentationConfig(input: unknown): ThemeConfigSnapshot {
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
    themeId: DEALER_THEME_ID,
    tokens,
    variants,
  });
}

export const DEALER_THEME_MANIFEST = Object.freeze({
  id: DEALER_THEME_ID,
  name: "Automotive & Vehicle Showroom",
  tagline: "Showroom kendaraan baru dan bekas dengan status unit jelas dan estimasi kredit statis.",
  description:
    "Tata letak showroom teknis dengan badge Tersedia/Dipesan/Terjual, spesifikasi rapi, tabel estimasi kredit statis berbasis Rupiah bulat, dan penjadwalan test drive.",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "included" as const,
  recommendedBlueprintIds: ["sales_executive"] as const,
  recommendedOfferingTypes: ["vehicle", "service"] as readonly OfferingType[],
  supportedRoutes: DEALER_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  styleVariants: getStyleVariantsForTheme(DEALER_THEME_ID) as readonly ThemeStyleVariantDefinition[],
  palette: Object.freeze({
    surface: "#ffffff",
    surfaceMuted: "#f4f6f8",
    ink: "#0f172a",
    inkMuted: "#475569",
    border: "#d6dce4",
  }),
  validatePresentationConfig: validateDealerPresentationConfig,
});
