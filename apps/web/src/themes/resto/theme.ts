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
 * Platform Theme Manifest: `resto` — F&B, Culinary & Multi-Branch Offline Outlets
 * (REQ-018, REQ-020, REQ-093, PLAN §7.3 & §19.8, DESIGN.md §7, TASK-093).
 */

export const RESTO_THEME_ID = "resto" as const;

export const RESTO_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse({
  primaryColor: "#9a3412",
  secondaryColor: "#14532d",
  accentColor: "#854d0e",
  surfaceColor: "#fffdf9",
  textColor: "#1f1712",
  fontFamily: "system",
  borderRadiusPx: 10,
  spacingScale: 1,
  containerMaxWidthPx: 1180,
  sectionPaddingYPx: 60,
  fastestSystemFont: false,
});

const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse({
  styleVariant: "default",
  headerVariant: "centered",
  footerVariant: "columns",
  heroVariant: "banner",
  buttonStyle: "solid",
});

export function validateRestoPresentationConfig(input: unknown): ThemeConfigSnapshot {
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
    themeId: RESTO_THEME_ID,
    tokens,
    variants,
  });
}

export const RESTO_THEME_MANIFEST = Object.freeze({
  id: RESTO_THEME_ID,
  name: "F&B & Multi-Branch Outlets",
  tagline: "Hangat dan informatif untuk restoran, kafe, katering, dan usaha multi-cabang.",
  description:
    "Menonjolkan etalase menu atau paket layanan, direktori cabang dengan jam buka hari kerja dan libur, tautan peta tanpa JS, dan reservasi WhatsApp.",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "included" as const,
  recommendedBlueprintIds: ["offline_multibranch"] as const,
  recommendedOfferingTypes: ["product", "service"] as readonly OfferingType[],
  supportedRoutes: RESTO_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  styleVariants: getStyleVariantsForTheme(RESTO_THEME_ID) as readonly ThemeStyleVariantDefinition[],
  palette: Object.freeze({
    surface: "#fffdf9",
    surfaceMuted: "#f7f2ea",
    ink: "#1f1712",
    inkMuted: "#5c4d42",
    border: "#e5dacb",
  }),
  validatePresentationConfig: validateRestoPresentationConfig,
});
