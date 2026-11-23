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
 * Platform Theme Manifest: `sales` — Sales Compro, Personal Branding & Services
 * (REQ-018, REQ-020, REQ-093, PLAN §7.3 & §19.8, DESIGN.md §7, TASK-093).
 */

export const SALES_THEME_ID = "sales" as const;

export const SALES_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse({
  primaryColor: "#1e40af",
  secondaryColor: "#0f766e",
  accentColor: "#9a3412",
  surfaceColor: "#ffffff",
  textColor: "#0f172a",
  fontFamily: "system",
  borderRadiusPx: 8,
  spacingScale: 1,
  containerMaxWidthPx: 1160,
  sectionPaddingYPx: 64,
  fastestSystemFont: false,
});

const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse({
  styleVariant: "default",
  headerVariant: "sticky-cta",
  footerVariant: "compact",
  heroVariant: "centered",
  buttonStyle: "solid",
});

export function validateSalesPresentationConfig(input: unknown): ThemeConfigSnapshot {
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
    themeId: SALES_THEME_ID,
    tokens,
    variants,
  });
}

export const SALES_THEME_MANIFEST = Object.freeze({
  id: SALES_THEME_ID,
  name: "Sales Compro & Personal Branding",
  tagline: "Kredibilitas konsultan penjualan resmi, pembicara, dan jasa spesialis.",
  description:
    "Menonjolkan otoritas personal, afiliasi dealer/lembaga resmi, tahapan cara kerja, tabel OTR/kredit statis, serta dukungan Landing Page Focus Mode.",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "included" as const,
  recommendedBlueprintIds: ["sales_executive", "personal_brand", "regulated_professional"] as const,
  recommendedOfferingTypes: ["service", "product", "vehicle"] as readonly OfferingType[],
  supportedRoutes: SALES_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  styleVariants: getStyleVariantsForTheme(SALES_THEME_ID) as readonly ThemeStyleVariantDefinition[],
  palette: Object.freeze({
    surface: "#ffffff",
    surfaceMuted: "#f5f7fb",
    ink: "#0f172a",
    inkMuted: "#475569",
    border: "#dbe3ee",
  }),
  validatePresentationConfig: validateSalesPresentationConfig,
});
