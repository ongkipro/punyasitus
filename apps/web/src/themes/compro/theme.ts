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

/**
 * Platform Theme Manifest: `compro` — Corporate / B2B Compro
 * (REQ-018, REQ-020, REQ-093, PLAN §7.3 & §19.8, DESIGN.md §7, TASK-093).
 *
 * Pure presentation manifest: zero DB, auth, Worker, or admin imports.
 * Defaults to zero-download system font stack (`<= 1` custom font allowed).
 */

export const COMPRO_THEME_ID = "compro" as const;

export const COMPRO_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

export type ComproSupportedRoute = (typeof COMPRO_SUPPORTED_ROUTES)[number];

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse({
  primaryColor: "#176b51",
  secondaryColor: "#0f4c5c",
  accentColor: "#1d4ed8",
  surfaceColor: "#ffffff",
  textColor: "#111c19",
  fontFamily: "system",
  borderRadiusPx: 8,
  spacingScale: 1,
  containerMaxWidthPx: 1200,
  sectionPaddingYPx: 64,
  fastestSystemFont: false,
});

const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse({
  styleVariant: "default",
  headerVariant: "standard",
  footerVariant: "columns",
  heroVariant: "split",
  buttonStyle: "solid",
});

export function validateComproPresentationConfig(input: unknown): ThemeConfigSnapshot {
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
    themeId: COMPRO_THEME_ID,
    tokens,
    variants,
  });
}

export const COMPRO_THEME_MANIFEST = Object.freeze({
  id: COMPRO_THEME_ID,
  name: "Corporate / B2B Compro",
  tagline: "Profil perusahaan presisi untuk manufaktur, kontraktor, dan layanan B2B.",
  description:
    "Tata letak arsitektural dengan hero split 5:7, jalur fakta kapasitas & kredensial opsional, kartu kapabilitas bernomor, dan formulir permintaan penawaran (RFQ).",
  version: "1.0.0",
  schemaVersion: 1 as const,
  tier: "included" as const,
  recommendedBlueprintIds: ["b2b_corporate", "regulated_professional"] as const,
  recommendedOfferingTypes: ["service", "product"] as readonly OfferingType[],
  supportedRoutes: COMPRO_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES as readonly ClosedSectionType[],
  fontBudget: Object.freeze({
    defaultFont: "system" as const,
    maxCustomFonts: 1 as const,
  }),
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  palette: Object.freeze({
    surface: "#ffffff",
    surfaceMuted: "#f4f7f5",
    ink: "#111c19",
    inkMuted: "#4b5c55",
    border: "#d8e2dc",
  }),
  validatePresentationConfig: validateComproPresentationConfig,
});
