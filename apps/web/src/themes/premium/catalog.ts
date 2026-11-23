import type { OfferingType } from "@punyasitus/core/schemas/common";
import type {
  ClosedSectionType,
  PlatformThemeId,
  ThemeTokens,
  ThemeVariants,
} from "@punyasitus/core/theme/index";
import type {
  PremiumThemeId,
  ThemeStyleVariantDefinition,
} from "@punyasitus/core/theme/variants";
import { ATELIER_EDITORIAL_THEME_MANIFEST } from "./atelier-editorial/theme.ts";
import { NUSANTARA_FLAGSHIP_THEME_MANIFEST } from "./nusantara-flagship/theme.ts";

/**
 * Static Build-Time Curated `paid_once` Premium Theme Registry
 * (REQ-096, ADR-0010, PLAN §11.4 & §19.7; TASK-096).
 *
 * Security invariants:
 * - Strictly static build-time imports only (ZERO `.zip` uploads, ZERO `eval`, ZERO dynamic imports).
 * - Pure presentation manifests with WCAG-AA verified palettes & `<= 1` custom font.
 */

export interface PremiumThemeManifestEntry {
  readonly id: PremiumThemeId;
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly version: string;
  readonly schemaVersion: 1;
  readonly tier: "paid_once";
  readonly priceIdr: number;
  readonly basePlatformThemeId: PlatformThemeId;
  readonly recommendedOfferingTypes: readonly OfferingType[];
  readonly supportedRoutes: readonly string[];
  readonly supportedSectionTypes: readonly ClosedSectionType[];
  readonly fontBudget: { readonly defaultFont: "system"; readonly maxCustomFonts: 1 };
  readonly styleVariants: readonly ThemeStyleVariantDefinition[];
  readonly defaultTokens: ThemeTokens;
  readonly defaultVariants: ThemeVariants;
  readonly palette: {
    readonly surface: string;
    readonly surfaceMuted: string;
    readonly ink: string;
    readonly inkMuted: string;
    readonly border: string;
  };
  readonly previewImagePath: string;
}

export const CURATED_PREMIUM_THEMES: readonly PremiumThemeManifestEntry[] = Object.freeze([
  ATELIER_EDITORIAL_THEME_MANIFEST,
  NUSANTARA_FLAGSHIP_THEME_MANIFEST,
]);

const PREMIUM_THEME_BY_ID: ReadonlyMap<string, PremiumThemeManifestEntry> = new Map(
  CURATED_PREMIUM_THEMES.map((entry) => [entry.id, entry]),
);

export function getCuratedPremiumTheme(themeId: string): PremiumThemeManifestEntry | null {
  const clean = themeId.trim();
  return (
    PREMIUM_THEME_BY_ID.get(clean) ??
    CURATED_PREMIUM_THEMES.find((t) => t.slug === clean) ??
    null
  );
}

export function listCuratedPremiumThemes(): readonly PremiumThemeManifestEntry[] {
  return CURATED_PREMIUM_THEMES;
}
