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
import type { OfferingType } from "@punyasitus/core/schemas/common";

/**
 * Sample Agency Custom Theme Manifest (`custom-sample-agency`)
 * (REQ-021, REQ-040, REQ-063, REQ-066; PLAN §7.3 & §11.4; TASK-018).
 *
 * Strictly adheres to `docs/themes/THEME-DEVELOPMENT.md`:
 * - Pure presentation manifest with zero DB, auth, Worker binding, or admin UI imports.
 * - Registered via explicit build-time static import in `apps/web/src/core/theme-registry.ts`.
 * - Covers all 7 public route kinds and delegates every closed section type so switching
 *   between any built-in platform theme and `custom-sample-agency` is 100% lossless.
 * - All default colors satisfy WCAG 2.2 AA (>= 4.5:1) contrast on `#fbf9f5`.
 */

export const SAMPLE_AGENCY_THEME_ID = "custom-sample-agency" as const;
export const SAMPLE_AGENCY_SCHEMA_VERSION = 1 as const;

export const SAMPLE_AGENCY_SUPPORTED_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

export type SampleAgencySupportedRoute = (typeof SAMPLE_AGENCY_SUPPORTED_ROUTES)[number];

export interface SampleAgencyThemeSurfacePalette {
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly border: string;
}

export interface SampleAgencyCustomThemeManifest {
  readonly id: typeof SAMPLE_AGENCY_THEME_ID;
  readonly slug: "sample-agency";
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly schemaVersion: typeof SAMPLE_AGENCY_SCHEMA_VERSION;
  readonly tier: "custom";
  readonly basePlatformThemeId: "compro";
  readonly recommendedOfferingTypes: readonly OfferingType[];
  readonly supportedRoutes: readonly SampleAgencySupportedRoute[];
  readonly supportedSectionTypes: readonly ClosedSectionType[];
  readonly defaultTokens: ThemeTokens;
  readonly defaultVariants: ThemeVariants;
  readonly palette: SampleAgencyThemeSurfacePalette;
  readonly previewImagePath: string;
  readonly agencyScope: {
    readonly distribution: "private_client";
    readonly ownerAgencySlug: string;
  };
  readonly validatePresentationConfig: (input: unknown) => ThemeConfigSnapshot;
}

const DEFAULT_TOKENS: ThemeTokens = ThemeTokensSchema.parse({
  primaryColor: "#1c2d4a",
  secondaryColor: "#9c3d1a",
  accentColor: "#0f5257",
  surfaceColor: "#fbf9f5",
  textColor: "#171a1f",
  fontFamily: "system",
  borderRadiusPx: 2,
  spacingScale: 1,
  containerMaxWidthPx: 1200,
  sectionPaddingYPx: 68,
  fastestSystemFont: false,
});

const DEFAULT_VARIANTS: ThemeVariants = ThemeVariantsSchema.parse({
  styleVariant: "editorial-studio",
  headerVariant: "standard",
  footerVariant: "columns",
  heroVariant: "split",
  buttonStyle: "solid",
});

const DEFAULT_PALETTE: SampleAgencyThemeSurfacePalette = Object.freeze({
  surface: "#fbf9f5",
  surfaceMuted: "#f2ede4",
  ink: "#171a1f",
  inkMuted: "#4a515d",
  border: "#dcd4c6",
});

function validateSampleAgencyPresentationConfig(input: unknown): ThemeConfigSnapshot {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const mergedTokens =
    raw.tokens && typeof raw.tokens === "object" && !Array.isArray(raw.tokens)
      ? { ...DEFAULT_TOKENS, ...(raw.tokens as Record<string, unknown>) }
      : { ...DEFAULT_TOKENS };

  const mergedVariants =
    raw.variants && typeof raw.variants === "object" && !Array.isArray(raw.variants)
      ? { ...DEFAULT_VARIANTS, ...(raw.variants as Record<string, unknown>) }
      : { ...DEFAULT_VARIANTS };

  return validateThemeConfigSnapshot({
    themeId: SAMPLE_AGENCY_THEME_ID,
    tokens: mergedTokens,
    variants: mergedVariants,
  });
}

export const SAMPLE_AGENCY_THEME_MANIFEST: SampleAgencyCustomThemeManifest = Object.freeze({
  id: SAMPLE_AGENCY_THEME_ID,
  slug: "sample-agency",
  name: "Editorial Studio Agency (Sample)",
  description:
    "Reference bespoke agency theme featuring warm editorial alabaster surfaces, deep architectural navy & terracotta accents, hairline grids, and full lossless section compatibility.",
  version: "1.0.0",
  schemaVersion: SAMPLE_AGENCY_SCHEMA_VERSION,
  tier: "custom",
  basePlatformThemeId: "compro",
  recommendedOfferingTypes: ["service", "product", "tour", "vehicle"] as const,
  supportedRoutes: SAMPLE_AGENCY_SUPPORTED_ROUTES,
  supportedSectionTypes: CLOSED_SECTION_TYPES,
  defaultTokens: DEFAULT_TOKENS,
  defaultVariants: DEFAULT_VARIANTS,
  palette: DEFAULT_PALETTE,
  previewImagePath: "/themes/custom/sample-agency/preview.webp",
  agencyScope: Object.freeze({
    distribution: "private_client" as const,
    ownerAgencySlug: "sample-agency",
  }),
  validatePresentationConfig: validateSampleAgencyPresentationConfig,
});
