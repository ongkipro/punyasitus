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
 * Platform Theme Manifest: `travel` — Travel & Umrah Agency
 * (REQ-018, REQ-020, REQ-093, PLAN §7.3 & §19.8, DESIGN.md §7, TASK-093).
 *
 * Agency showcase only — NEVER an OTA/ticketing portal and ZERO fake scarcity/seat-quota bars.
 */

export const TRAVEL_THEME_ID = "travel" as const;

export const TRAVEL_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse({
  primaryColor: "#0f5c5c",
  secondaryColor: "#92400e",
  accentColor: "#115e59",
  surfaceColor: "#ffffff",
  textColor: "#132221",
  fontFamily: "system",
  borderRadiusPx: 10,
  spacingScale: 1,
  containerMaxWidthPx: 1200,
  sectionPaddingYPx: 64,
  fastestSystemFont: false,
});

const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse({
  styleVariant: "default",
  headerVariant: "standard",
  footerVariant: "columns",
  heroVariant: "banner",
  buttonStyle: "solid",
});

export function validateTravelPresentationConfig(input: unknown): ThemeConfigSnapshot {
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
    themeId: TRAVEL_THEME_ID,
    tokens,
    variants,
  });
}

export const TRAVEL_THEME_MANIFEST = Object.freeze({
  id: TRAVEL_THEME_ID,
  name: "Travel & Umrah Agency",
  tagline: "Etalase biro perjalanan dan Umrah berizin sesuai 5 Pasti & Permenpar 6/2025.",
  description:
    "Dirancang untuk biro perjalanan wisata dan PPIU/PIHK resmi dengan paket transparan, jadwal aktif otomatis, dan konsultasi WhatsApp tanpa elemen kelangkaan palsu.",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "included" as const,
  recommendedBlueprintIds: ["travel_umrah_agency"] as const,
  recommendedOfferingTypes: ["tour", "service"] as readonly OfferingType[],
  supportedRoutes: TRAVEL_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  styleVariants: getStyleVariantsForTheme(TRAVEL_THEME_ID) as readonly ThemeStyleVariantDefinition[],
  palette: Object.freeze({
    surface: "#ffffff",
    surfaceMuted: "#f5f8f7",
    ink: "#132221",
    inkMuted: "#485c5a",
    border: "#d7e3e0",
  }),
  validatePresentationConfig: validateTravelPresentationConfig,
});
