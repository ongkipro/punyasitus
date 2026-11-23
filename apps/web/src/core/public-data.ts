import {
  BusinessProfileSnapshotSchema,
  MenuSnapshotSchema,
  PageSnapshotSchema,
  sanitizeNavigationHref,
  SiteSettingsSnapshotSchema,
  stripDraftOnlyFields,
  type BusinessProfileSnapshot,
  type MenuSnapshot,
  type PageLayoutMode,
  type PageSnapshot,
  type PublishableResourceType,
  type PublishedResourceDto,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import { ThemeIdSchema } from "@punyasitus/core/schemas/common";
import {
  ALL_OFFERING_TYPES,
  extractGroupedSettingsExtension,
  filterPublicNavigationForSettings,
  type PublicReadingDefaults,
} from "@punyasitus/core/settings/index";
import {
  computeContrastRatio,
  ensureAccessibleBrandColor,
  hasDangerousCssSyntax,
  parseAndValidateThemeJson,
  PLATFORM_THEME_IDS,
  renderThemeCssCustomProperties,
  sanitizeThemeColor,
  THEME_FONT_STACKS,
  ThemeTokensSchema,
  validateThemeConfigSnapshot,
  validateThemeTokens,
  validateThemeVariants,
  type AllowedThemeFont,
  type PlatformThemeId,
  type ThemeConfigSnapshot,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import {
  listPublishedOutletsForPublic,
  type OutletRecord,
} from "@punyasitus/db/outlets/index";
import { getPublishedResource, type GetResourceParams } from "@punyasitus/db/publication/index";

/**
 * Published Public Tenant Shell Data Loader & Safe Theme Token Injector
 * (REQ-018, REQ-020, REQ-036, REQ-040, PLAN §7.1 & §7.3, DESIGN.md §2.2 & §7, TASK-012).
 *
 * Security & Isolation Guarantees:
 * - Public reads load ONLY published tenant snapshots from `TenantStore` via
 *   `getPublishedResource` — NEVER falling back to draft columns or unpublished rows.
 * - Malformed or hostile `theme_config` values (`url(`, `expression(`, `;`, `}`,
 *   `</style>`, `<script>`) NEVER produce executable CSS and fall back cleanly to
 *   WCAG AA (>= 4.5:1) verified per-theme defaults.
 * - Bounded, pre-validated draft DTO overrides are honored ONLY when explicitly
 *   invoked with `previewMode: true` (downstream TASK-050).
 */

export type ShellLayoutMode = PageLayoutMode;
export type PublicMenuItem = MenuSnapshot["items"][number];

export interface ThemeSurfacePalette {
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly border: string;
}

export interface PlatformThemePreset {
  readonly themeId: PlatformThemeId;
  readonly label: string;
  readonly tokens: ThemeTokens;
  readonly variants: ThemeVariants;
  readonly palette: ThemeSurfacePalette;
}

/**
 * Code-defined WCAG AA (>= 4.5:1) baseline design token presets for all six
 * PunyaSitus platform themes (REQ-018, REQ-020, DESIGN.md §7).
 * Every preset defaults to the zero-download system font stack (`fontFamily: "system"`).
 */
export const PLATFORM_THEME_PRESETS: Readonly<Record<PlatformThemeId, PlatformThemePreset>> = {
  compro: {
    themeId: "compro",
    label: "Corporate / B2B Compro",
    tokens: {
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
    },
    variants: {
      styleVariant: "default",
      headerVariant: "standard",
      footerVariant: "columns",
      heroVariant: "split",
      buttonStyle: "solid",
    },
    palette: {
      surface: "#ffffff",
      surfaceMuted: "#f4f7f5",
      ink: "#111c19",
      inkMuted: "#4b5c55",
      border: "#d8e2dc",
    },
  },
  sales: {
    themeId: "sales",
    label: "Sales Compro & Personal Branding",
    tokens: {
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
    },
    variants: {
      styleVariant: "default",
      headerVariant: "sticky-cta",
      footerVariant: "compact",
      heroVariant: "centered",
      buttonStyle: "solid",
    },
    palette: {
      surface: "#ffffff",
      surfaceMuted: "#f5f7fb",
      ink: "#0f172a",
      inkMuted: "#475569",
      border: "#dbe3ee",
    },
  },
  travel: {
    themeId: "travel",
    label: "Travel & Umrah Agency",
    tokens: {
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
    },
    variants: {
      styleVariant: "default",
      headerVariant: "standard",
      footerVariant: "columns",
      heroVariant: "banner",
      buttonStyle: "solid",
    },
    palette: {
      surface: "#ffffff",
      surfaceMuted: "#f5f8f7",
      ink: "#132221",
      inkMuted: "#485c5a",
      border: "#d7e3e0",
    },
  },
  catalog: {
    themeId: "catalog",
    label: "Product Showcase Catalog",
    tokens: {
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
    },
    variants: {
      styleVariant: "default",
      headerVariant: "standard",
      footerVariant: "columns",
      heroVariant: "minimal",
      buttonStyle: "solid",
    },
    palette: {
      surface: "#ffffff",
      surfaceMuted: "#f7f8fa",
      ink: "#111827",
      inkMuted: "#4b5563",
      border: "#dde2e8",
    },
  },
  resto: {
    themeId: "resto",
    label: "F&B & Multi-Branch Outlets",
    tokens: {
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
    },
    variants: {
      styleVariant: "default",
      headerVariant: "centered",
      footerVariant: "columns",
      heroVariant: "banner",
      buttonStyle: "solid",
    },
    palette: {
      surface: "#fffdf9",
      surfaceMuted: "#f7f2ea",
      ink: "#1f1712",
      inkMuted: "#5c4d42",
      border: "#e5dacb",
    },
  },
  dealer: {
    themeId: "dealer",
    label: "Automotive & Vehicle Showroom",
    tokens: {
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
    },
    variants: {
      styleVariant: "default",
      headerVariant: "sticky-cta",
      footerVariant: "columns",
      heroVariant: "split",
      buttonStyle: "solid",
    },
    palette: {
      surface: "#ffffff",
      surfaceMuted: "#f4f6f8",
      ink: "#0f172a",
      inkMuted: "#475569",
      border: "#d6dce4",
    },
  },
};

const PLATFORM_THEME_SET = new Set<string>(PLATFORM_THEME_IDS);
const SAFE_EMITTED_CSS_FORBIDDEN_RE =
  /<\/?\s*(?:style|script)|url\s*\(|expression\s*\(|@import|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding/i;

export interface ThemeContrastDisclosure {
  readonly primaryOriginal: string;
  readonly primaryResolved: string;
  readonly primaryAdjusted: boolean;
  readonly primaryRatio: number;
  readonly secondaryOriginal: string;
  readonly secondaryResolved: string;
  readonly secondaryAdjusted: boolean;
  readonly secondaryRatio: number;
  readonly onPrimary: "#ffffff" | "#050505";
  readonly onSecondary: "#ffffff" | "#050505";
}

export interface SafeThemeStyleBlock {
  readonly css: string;
  readonly themeId: string;
  readonly baseThemeId: PlatformThemeId;
  readonly tokens: ThemeTokens;
  readonly variants: ThemeVariants;
  readonly palette: ThemeSurfacePalette;
  readonly contrast: ThemeContrastDisclosure;
  readonly fallbackUsed: boolean;
  readonly fallbackReason: string | null;
}

export interface PublicSiteInfo {
  readonly title: string;
  readonly tagline: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly blogEnabled: boolean;
  readonly catalogEnabled: boolean;
  readonly siteVisibility: "public" | "noindex";
  readonly analyticsConfig: SiteSettingsSnapshot["analyticsConfig"];
}

export interface PublicBusinessInfo {
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly mapsUrl: string | null;
  readonly weekdayHours: string | null;
  readonly holidayHours: string | null;
  readonly phone: string | null;
  readonly whatsappE164: string | null;
  readonly email: string | null;
  readonly socialLinks: BusinessProfileSnapshot["socialLinks"];
}

export interface PublicShellMenus {
  readonly header: readonly PublicMenuItem[];
  readonly footer: readonly PublicMenuItem[];
  readonly mobile: readonly PublicMenuItem[];
}

export interface TenantShellRevisions {
  readonly siteSettingsVersion: number | null;
  readonly businessProfileVersion: number | null;
  readonly themeConfigVersion: number | null;
  readonly pageVersion: number | null;
}

export type PublicOutletItem = OutletRecord;

export interface TenantShellData {
  readonly isPreview: boolean;
  readonly layoutMode: ShellLayoutMode;
  readonly themeId: string;
  readonly baseThemeId: PlatformThemeId;
  readonly themeStyle: SafeThemeStyleBlock;
  readonly site: PublicSiteInfo;
  readonly business: PublicBusinessInfo;
  readonly menus: PublicShellMenus;
  readonly page: PageSnapshot | null;
  readonly outlets?: readonly PublicOutletItem[];
  readonly revisions: TenantShellRevisions;
}

export interface PreviewShellDraftOverride {
  readonly siteSettings?: unknown;
  readonly businessProfile?: unknown;
  readonly themeConfig?: unknown;
  readonly menus?: {
    readonly header?: unknown;
    readonly footer?: unknown;
    readonly mobile?: unknown;
  };
  readonly page?: unknown;
  readonly layoutMode?: unknown;
}

export interface LoadPublishedTenantShellOptions {
  readonly pageSlug?: string;
  readonly themeIdOverride?: string;
  readonly layoutModeOverride?: unknown;
  /**
   * Explicitly enables bounded, pre-validated draft DTO override ONLY for
   * authorized admin preview (TASK-050). Defaults to `false`.
   */
  readonly previewMode?: boolean;
  readonly previewDraftOverride?: PreviewShellDraftOverride;
  readonly fallbackSiteTitle?: string;
  readonly fallbackBusinessName?: string;
}

/**
 * Resolves a requested theme ID to one of the six built-in platform theme IDs
 * for safe preset inheritance (custom themes inherit `compro` defaults).
 */
export function resolveBasePlatformThemeId(themeId: unknown): PlatformThemeId {
  if (typeof themeId === "string" && PLATFORM_THEME_SET.has(themeId)) {
    return themeId as PlatformThemeId;
  }
  return "compro";
}

/**
 * Resolves a validated theme ID (`compro`..`dealer` or `custom-<slug>`),
 * falling back cleanly to `"compro"` if missing or malformed.
 */
export function resolveSafeThemeId(themeId: unknown): string {
  if (typeof themeId === "string") {
    const parsed = ThemeIdSchema.safeParse(themeId.trim());
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "compro";
}

/**
 * Resolves shell layout mode strictly to `"standard"` or `"focused"`
 * (Landing Page Focus Mode hiding top/footer navigation menus, DESIGN.md §7).
 */
export function resolveSafeShellLayoutMode(layoutMode: unknown): ShellLayoutMode {
  return layoutMode === "focused" ? "focused" : "standard";
}

/**
 * Picks high-contrast foreground text (`#ffffff` vs `#050505` per DESIGN.md §2.2 DEC-033)
 * for buttons and badges placed on top of a brand color.
 */
function pickAccessibleOnColor(bgHex: string): "#ffffff" | "#050505" {
  const whiteRatio = computeContrastRatio("#ffffff", bgHex);
  const darkRatio = computeContrastRatio("#050505", bgHex);
  return whiteRatio >= darkRatio ? "#ffffff" : "#050505";
}

function parseHexToRgb(hex6: string): readonly [number, number, number] {
  const clean = sanitizeThemeColor(hex6);
  return [
    Number.parseInt(clean.slice(1, 3), 16),
    Number.parseInt(clean.slice(3, 5), 16),
    Number.parseInt(clean.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

function mixHex(hexA: string, hexB: string, weightB: number): string {
  const [r1, g1, b1] = parseHexToRgb(hexA);
  const [r2, g2, b2] = parseHexToRgb(hexB);
  const w = Math.max(0, Math.min(1, weightB));
  return rgbToHex(r1 + (r2 - r1) * w, g1 + (g2 - g1) * w, b1 + (b2 - b1) * w);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractSafeSnapshotFromInput(
  rawInput: unknown,
  resolvedThemeId: string,
  preset: PlatformThemePreset,
): {
  readonly snapshot: ThemeConfigSnapshot;
  readonly fallbackUsed: boolean;
  readonly fallbackReason: string | null;
} {
  const defaultSnapshot: ThemeConfigSnapshot = {
    themeId: resolvedThemeId,
    tokens: { ...preset.tokens },
    variants: { ...preset.variants },
  };

  if (rawInput === null || rawInput === undefined) {
    return {
      snapshot: defaultSnapshot,
      fallbackUsed: false,
      fallbackReason: null,
    };
  }

  try {
    // Support raw JSON string input via parseAndValidateThemeJson
    if (typeof rawInput === "string") {
      if (hasDangerousCssSyntax(rawInput) && !rawInput.trim().startsWith("{")) {
        return {
          snapshot: defaultSnapshot,
          fallbackUsed: true,
          fallbackReason: "UNSAFE_RAW_THEME_STRING",
        };
      }
      const parsedSnapshot = parseAndValidateThemeJson(
        resolvedThemeId,
        rawInput,
        JSON.stringify(preset.variants),
      );
      return {
        snapshot: parsedSnapshot,
        fallbackUsed: false,
        fallbackReason: null,
      };
    }

    if (!isPlainObject(rawInput)) {
      return {
        snapshot: defaultSnapshot,
        fallbackUsed: true,
        fallbackReason: "INVALID_THEME_INPUT_TYPE",
      };
    }

    // Raw DB pair `{ tokensJson, variantsJson }`
    if (typeof rawInput.tokensJson === "string" || typeof rawInput.variantsJson === "string") {
      const tokensJson =
        typeof rawInput.tokensJson === "string"
          ? rawInput.tokensJson
          : JSON.stringify(preset.tokens);
      const variantsJson =
        typeof rawInput.variantsJson === "string"
          ? rawInput.variantsJson
          : JSON.stringify(preset.variants);
      const parsedSnapshot = parseAndValidateThemeJson(resolvedThemeId, tokensJson, variantsJson);
      return {
        snapshot: parsedSnapshot,
        fallbackUsed: false,
        fallbackReason: null,
      };
    }

    // Complete ThemeConfigSnapshot `{ themeId?, tokens, variants? }`
    if ("tokens" in rawInput) {
      const candidateThemeId =
        typeof rawInput.themeId === "string" ? rawInput.themeId : resolvedThemeId;
      const tokensObj = isPlainObject(rawInput.tokens)
        ? {
            ...preset.tokens,
            ...rawInput.tokens,
          }
        : rawInput.tokens;
      const variantsObj =
        rawInput.variants === undefined
          ? preset.variants
          : isPlainObject(rawInput.variants)
            ? {
                ...preset.variants,
                ...rawInput.variants,
              }
            : rawInput.variants;

      const validated = validateThemeConfigSnapshot({
        themeId: candidateThemeId,
        tokens: tokensObj,
        variants: variantsObj,
      });
      return {
        snapshot: validated,
        fallbackUsed: false,
        fallbackReason: null,
      };
    }

    // Direct ThemeTokens object (full or partial)
    const mergedTokens = {
      ...preset.tokens,
      ...rawInput,
    };
    // Ensure strict schema rejects unknown/injected keys cleanly
    const validatedTokens = validateThemeTokens(mergedTokens);
    const validatedVariants = validateThemeVariants(preset.variants);
    return {
      snapshot: {
        themeId: resolvedThemeId,
        tokens: validatedTokens,
        variants: validatedVariants,
      },
      fallbackUsed: false,
      fallbackReason: null,
    };
  } catch {
    return {
      snapshot: defaultSnapshot,
      fallbackUsed: true,
      fallbackReason: "INVALID_OR_UNSAFE_THEME_TOKENS",
    };
  }
}

function buildFinalStyleCss(
  snapshot: ThemeConfigSnapshot,
  palette: ThemeSurfacePalette,
  contrast: ThemeContrastDisclosure,
): string {
  const coreRootBlock = renderThemeCssCustomProperties(snapshot);
  const { tokens } = snapshot;

  const effectiveBodyFont: AllowedThemeFont = tokens.fastestSystemFont
    ? "system"
    : tokens.fontFamily;
  const effectiveHeadingFont: AllowedThemeFont = tokens.fastestSystemFont
    ? "system"
    : (tokens.headingFontFamily ?? tokens.fontFamily);

  const siteDeclarations = [
    `--ps-brand-primary: ${contrast.primaryResolved}`,
    `--ps-brand-secondary: ${contrast.secondaryResolved}`,
    `--ps-brand-on-primary: ${contrast.onPrimary}`,
    `--ps-brand-on-secondary: ${contrast.onSecondary}`,
    `--ps-surface: ${palette.surface}`,
    `--ps-surface-muted: ${palette.surfaceMuted}`,
    `--ps-ink: ${palette.ink}`,
    `--ps-ink-muted: ${palette.inkMuted}`,
    `--ps-border: ${palette.border}`,
    `--ps-radius: ${tokens.borderRadiusPx}px`,
    `--ps-font-sans: ${THEME_FONT_STACKS[effectiveBodyFont]}`,
    `--ps-font-heading: ${THEME_FONT_STACKS[effectiveHeadingFont]}`,
    `--ps-container-max: ${tokens.containerMaxWidthPx}px`,
    `--ps-spacing-scale: ${Number(tokens.spacingScale.toFixed(3))}`,
    `--ps-section-py: ${tokens.sectionPaddingYPx}px`,
    `--ps-focus-ring: ${contrast.primaryResolved}`,
  ];

  // Emit both core `--ps-color-*` declarations and storefront `--ps-brand-*` tokens
  // with higher specificity (`:root, :root[data-ps-theme], body[data-ps-theme]`) than defaults in tokens.css.
  return `${coreRootBlock}\n:root, :root[data-ps-theme], body[data-ps-theme] { ${siteDeclarations.join("; ")}; }`;
}

/**
 * Validates and sanitizes tenant theme tokens through `@punyasitus/core/theme/index`,
 * enforces WCAG AA >= 4.5:1 contrast, and emits a guaranteed-safe SSR `<style>` CSS block.
 *
 * Any malformed or hostile token value (`url(`, `expression(`, `;`, `}`, `</style>`, `<script>`)
 * falls back cleanly to safe preset tokens for the resolved theme.
 */
export function buildSafeThemeStyleBlock(
  tokensInput: unknown,
  themeId: unknown = "compro",
): SafeThemeStyleBlock {
  const resolvedThemeId = resolveSafeThemeId(themeId);
  const baseThemeId = resolveBasePlatformThemeId(resolvedThemeId);
  const preset = PLATFORM_THEME_PRESETS[baseThemeId];

  const extracted = extractSafeSnapshotFromInput(tokensInput, resolvedThemeId, preset);
  const snapshot = extracted.snapshot;
  const { tokens, variants } = snapshot;

  const surface = tokens.surfaceColor ?? preset.palette.surface;
  const rawInk = tokens.textColor ?? preset.palette.ink;
  const accessibleInk = ensureAccessibleBrandColor(rawInk, surface, 4.5).color;
  const accessiblePrimary = ensureAccessibleBrandColor(tokens.primaryColor, surface, 4.5);
  const accessibleSecondary = ensureAccessibleBrandColor(tokens.secondaryColor, surface, 4.5);

  const surfaceMuted =
    tokens.surfaceColor && tokens.surfaceColor !== preset.palette.surface
      ? mixHex(surface, accessibleInk, 0.04)
      : preset.palette.surfaceMuted;
  const rawInkMuted =
    tokens.textColor && tokens.textColor !== preset.palette.ink
      ? mixHex(accessibleInk, surface, 0.3)
      : preset.palette.inkMuted;
  const inkMuted = ensureAccessibleBrandColor(rawInkMuted, surface, 4.5).color;
  const border =
    tokens.surfaceColor && tokens.surfaceColor !== preset.palette.surface
      ? mixHex(surface, accessibleInk, 0.14)
      : preset.palette.border;

  const palette: ThemeSurfacePalette = {
    surface,
    surfaceMuted,
    ink: accessibleInk,
    inkMuted,
    border,
  };

  const contrast: ThemeContrastDisclosure = {
    primaryOriginal: accessiblePrimary.originalColor,
    primaryResolved: accessiblePrimary.color,
    primaryAdjusted: accessiblePrimary.adjusted,
    primaryRatio: accessiblePrimary.contrastRatio,
    secondaryOriginal: accessibleSecondary.originalColor,
    secondaryResolved: accessibleSecondary.color,
    secondaryAdjusted: accessibleSecondary.adjusted,
    secondaryRatio: accessibleSecondary.contrastRatio,
    onPrimary: pickAccessibleOnColor(accessiblePrimary.color),
    onSecondary: pickAccessibleOnColor(accessibleSecondary.color),
  };

  const normalizedSnapshot: ThemeConfigSnapshot = {
    themeId: snapshot.themeId,
    tokens: ThemeTokensSchema.parse({
      ...tokens,
      primaryColor: accessiblePrimary.color,
      secondaryColor: accessibleSecondary.color,
      surfaceColor: surface,
      textColor: accessibleInk,
    }),
    variants,
  };

  let css = buildFinalStyleCss(normalizedSnapshot, palette, contrast);
  let fallbackUsed = extracted.fallbackUsed;
  let fallbackReason = extracted.fallbackReason;

  // Defense-in-depth guard: emitted CSS MUST NEVER contain HTML/CSS breakout syntax
  if (SAFE_EMITTED_CSS_FORBIDDEN_RE.test(css)) {
    const safeSnapshot: ThemeConfigSnapshot = {
      themeId: baseThemeId,
      tokens: { ...preset.tokens },
      variants: { ...preset.variants },
    };
    const safePrimary = ensureAccessibleBrandColor(preset.tokens.primaryColor, preset.palette.surface, 4.5);
    const safeSecondary = ensureAccessibleBrandColor(
      preset.tokens.secondaryColor,
      preset.palette.surface,
      4.5,
    );
    const safeContrast: ThemeContrastDisclosure = {
      primaryOriginal: safePrimary.originalColor,
      primaryResolved: safePrimary.color,
      primaryAdjusted: safePrimary.adjusted,
      primaryRatio: safePrimary.contrastRatio,
      secondaryOriginal: safeSecondary.originalColor,
      secondaryResolved: safeSecondary.color,
      secondaryAdjusted: safeSecondary.adjusted,
      secondaryRatio: safeSecondary.contrastRatio,
      onPrimary: pickAccessibleOnColor(safePrimary.color),
      onSecondary: pickAccessibleOnColor(safeSecondary.color),
    };
    css = buildFinalStyleCss(safeSnapshot, preset.palette, safeContrast);
    fallbackUsed = true;
    fallbackReason = "DEFENSE_IN_DEPTH_CSS_BLOCKED";
    return {
      css,
      themeId: baseThemeId,
      baseThemeId,
      tokens: safeSnapshot.tokens,
      variants: safeSnapshot.variants,
      palette: preset.palette,
      contrast: safeContrast,
      fallbackUsed,
      fallbackReason,
    };
  }

  return {
    css,
    themeId: normalizedSnapshot.themeId,
    baseThemeId,
    tokens: normalizedSnapshot.tokens,
    variants: normalizedSnapshot.variants,
    palette,
    contrast,
    fallbackUsed,
    fallbackReason,
  };
}

/**
 * Defensively sanitizes public navigation menu items (up to 3 levels),
 * dropping any entry with an unsafe href (`javascript:`, `data:`, `//evil`, etc.).
 */
export function sanitizePublicMenuItems(items: readonly PublicMenuItem[]): PublicMenuItem[] {
  const safeItems: PublicMenuItem[] = [];
  for (const l1 of items) {
    let safeL1Href: string;
    try {
      safeL1Href = sanitizeNavigationHref(l1.href);
    } catch {
      continue;
    }

    const safeL2Children: PublicMenuItem["children"] = [];
    for (const l2 of l1.children) {
      let safeL2Href: string;
      try {
        safeL2Href = sanitizeNavigationHref(l2.href);
      } catch {
        continue;
      }

      const safeL3Children: PublicMenuItem["children"][number]["children"] = [];
      for (const l3 of l2.children) {
        let safeL3Href: string;
        try {
          safeL3Href = sanitizeNavigationHref(l3.href);
        } catch {
          continue;
        }
        safeL3Children.push({
          label: l3.label,
          href: safeL3Href,
          openInNewTab: Boolean(l3.openInNewTab),
        });
      }

      safeL2Children.push({
        label: l2.label,
        href: safeL2Href,
        openInNewTab: Boolean(l2.openInNewTab),
        children: safeL3Children,
      });
    }

    safeItems.push({
      label: l1.label,
      href: safeL1Href,
      openInNewTab: Boolean(l1.openInNewTab),
      children: safeL2Children,
    });
  }
  return safeItems;
}

interface SafePublishedReadResult<K extends PublishableResourceType> {
  readonly dto: PublishedResourceDto<K> | null;
  readonly malformed: boolean;
}

async function safeGetPublishedResource<K extends PublishableResourceType>(
  tenantDb: D1Database,
  params: GetResourceParams<K>,
): Promise<SafePublishedReadResult<K>> {
  try {
    const dto = await getPublishedResource(tenantDb, params);
    return { dto, malformed: false };
  } catch {
    // Malformed stored published JSON fails closed to null/default — NEVER falling back to draft columns!
    return { dto: null, malformed: true };
  }
}

async function loadPublishedHomepage(
  tenantDb: D1Database,
): Promise<PublishedResourceDto<"page"> | null> {
  try {
    const row = await tenantDb
      .prepare(
        `SELECT id
         FROM pages
         WHERE is_homepage = 1
           AND status = 'published'
           AND deleted_at IS NULL
           AND published_sections_json IS NOT NULL
         LIMIT 1`,
      )
      .first<{ readonly id: number }>();
    if (!row || typeof row.id !== "number") {
      return null;
    }
    const res = await safeGetPublishedResource(tenantDb, {
      resourceType: "page",
      resourceId: row.id,
    });
    return res.dto;
  } catch {
    return null;
  }
}

const MAX_PREVIEW_OVERRIDE_BYTES = 256_000;

function isWithinPreviewBounds(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= MAX_PREVIEW_OVERRIDE_BYTES;
  } catch {
    return false;
  }
}

function parsePreviewOverride<T>(
  input: unknown,
  parser: (clean: unknown) => T,
): T | null {
  if (input === undefined || input === null) return null;
  if (!isWithinPreviewBounds(input)) return null;
  try {
    return parser(stripDraftOnlyFields(input));
  } catch {
    return null;
  }
}

/**
 * Loads ONLY published tenant shell snapshots (`site_settings`, `business_profile`,
 * `theme_config`, `menus` for `header`/`footer`/`mobile`, and active page/home snapshot)
 * from `TenantStore` via `getPublishedResource`.
 *
 * - Public reads NEVER access draft columns or unpublished rows.
 * - Corrupt/malicious stored `theme_config` falls back cleanly to WCAG-AA theme defaults.
 * - Bounded, pre-validated draft DTO overrides are applied ONLY when `options.previewMode === true`.
 */
async function loadPublishedGroupedReadingDefaults(
  tenantDb: D1Database,
): Promise<{ readonly enabledOfferingTypes: PublicReadingDefaults["enabledOfferingTypes"] } | null> {
  try {
    const tableRow = await tenantDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'site_settings_grouped' LIMIT 1`,
      )
      .first<{ readonly name: string }>();
    if (tableRow?.name === "site_settings_grouped") {
      const groupedRow = await tenantDb
        .prepare("SELECT published_json FROM site_settings_grouped WHERE id = 1 LIMIT 1")
        .first<{ readonly published_json: string | null }>();
      if (groupedRow?.published_json) {
        const ext = extractGroupedSettingsExtension(groupedRow.published_json);
        return { enabledOfferingTypes: ext.reading.enabledOfferingTypes };
      }
    }
    const siteRow = await tenantDb
      .prepare("SELECT published_json FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly published_json: string | null }>();
    if (siteRow?.published_json) {
      const ext = extractGroupedSettingsExtension(siteRow.published_json);
      return { enabledOfferingTypes: ext.reading.enabledOfferingTypes };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Loads ONLY published and active tenant outlets for public directory rendering & JSON-LD
 * (`REQ-029`, `REQ-054`, `TASK-019`). Fails closed to `[]` when `tenantDb` is unavailable
 * and NEVER leaks draft or inactive outlets.
 */
export async function loadPublishedPublicOutlets(
  tenantDb: D1Database | null | undefined,
): Promise<readonly PublicOutletItem[]> {
  if (!tenantDb) return [];
  try {
    return await listPublishedOutletsForPublic(tenantDb);
  } catch {
    return [];
  }
}

export async function loadPublishedTenantShellData(
  tenantDb: D1Database | null | undefined,
  options: LoadPublishedTenantShellOptions = {},
): Promise<TenantShellData> {
  const isPreview = options.previewMode === true;
  const fallbackSiteTitle = options.fallbackSiteTitle?.trim() || "PunyaSitus";
  const fallbackBusinessName = options.fallbackBusinessName?.trim() || fallbackSiteTitle;

  let publishedSettings: PublishedResourceDto<"site_settings"> | null = null;
  let publishedProfile: PublishedResourceDto<"business_profile"> | null = null;
  let publishedHeaderMenu: PublishedResourceDto<"menu"> | null = null;
  let publishedFooterMenu: PublishedResourceDto<"menu"> | null = null;
  let publishedMobileMenu: PublishedResourceDto<"menu"> | null = null;
  let publishedPage: PublishedResourceDto<"page"> | null = null;
  let publishedGroupedReading: {
    readonly enabledOfferingTypes: PublicReadingDefaults["enabledOfferingTypes"];
  } | null = null;
  let publishedOutlets: readonly PublicOutletItem[] = [];

  if (tenantDb) {
    const [
      settingsRes,
      profileRes,
      headerRes,
      footerRes,
      mobileRes,
      pageDto,
      groupedReading,
      outletsList,
    ] = await Promise.all([
      safeGetPublishedResource(tenantDb, { resourceType: "site_settings" }),
      safeGetPublishedResource(tenantDb, { resourceType: "business_profile" }),
      safeGetPublishedResource(tenantDb, { resourceType: "menu", location: "header" }),
      safeGetPublishedResource(tenantDb, { resourceType: "menu", location: "footer" }),
      safeGetPublishedResource(tenantDb, { resourceType: "menu", location: "mobile" }),
      options.pageSlug
        ? safeGetPublishedResource(tenantDb, { resourceType: "page", slug: options.pageSlug }).then(
            (r) => r.dto,
          )
        : loadPublishedHomepage(tenantDb),
      loadPublishedGroupedReadingDefaults(tenantDb),
      loadPublishedPublicOutlets(tenantDb),
    ]);

    publishedSettings = settingsRes.dto;
    publishedProfile = profileRes.dto;
    publishedHeaderMenu = headerRes.dto;
    publishedFooterMenu = footerRes.dto;
    publishedMobileMenu = mobileRes.dto;
    publishedPage = pageDto;
    publishedGroupedReading = groupedReading;
    publishedOutlets = outletsList;
  }

  let effectiveSettings: SiteSettingsSnapshot | null = publishedSettings?.data ?? null;
  let effectiveProfile: BusinessProfileSnapshot | null = publishedProfile?.data ?? null;
  let effectiveHeaderItems: readonly PublicMenuItem[] = publishedHeaderMenu?.data.items ?? [];
  let effectiveFooterItems: readonly PublicMenuItem[] = publishedFooterMenu?.data.items ?? [];
  let effectiveMobileItems: readonly PublicMenuItem[] = publishedMobileMenu?.data.items ?? [];
  let effectivePage: PageSnapshot | null = publishedPage?.data ?? null;

  // Apply bounded, pre-validated draft overrides ONLY when explicitly in previewMode
  const override = isPreview ? options.previewDraftOverride : undefined;
  if (override) {
    const parsedSettings = parsePreviewOverride(override.siteSettings, (v) =>
      SiteSettingsSnapshotSchema.parse(v),
    );
    if (parsedSettings) effectiveSettings = parsedSettings;

    const parsedProfile = parsePreviewOverride(override.businessProfile, (v) =>
      BusinessProfileSnapshotSchema.parse(v),
    );
    if (parsedProfile) effectiveProfile = parsedProfile;

    const parsedPage = parsePreviewOverride(override.page, (v) => PageSnapshotSchema.parse(v));
    if (parsedPage) effectivePage = parsedPage;

    if (override.menus) {
      const parsedHeader = parsePreviewOverride(override.menus.header, (v) =>
        MenuSnapshotSchema.parse(v),
      );
      if (parsedHeader) effectiveHeaderItems = parsedHeader.items;

      const parsedFooter = parsePreviewOverride(override.menus.footer, (v) =>
        MenuSnapshotSchema.parse(v),
      );
      if (parsedFooter) effectiveFooterItems = parsedFooter.items;

      const parsedMobile = parsePreviewOverride(override.menus.mobile, (v) =>
        MenuSnapshotSchema.parse(v),
      );
      if (parsedMobile) effectiveMobileItems = parsedMobile.items;
    }
  }

  const resolvedThemeId = resolveSafeThemeId(
    options.themeIdOverride ?? effectiveSettings?.activeThemeId ?? "compro",
  );

  let publishedTheme: PublishedResourceDto<"theme_config"> | null = null;
  let storedThemeMalformed = false;
  if (tenantDb) {
    const themeRes = await safeGetPublishedResource(tenantDb, {
      resourceType: "theme_config",
      resourceId: resolvedThemeId,
    });
    publishedTheme = themeRes.dto;
    storedThemeMalformed = themeRes.malformed;
  }

  let themeInput: unknown = publishedTheme?.data ?? null;
  if (override && override.themeConfig !== undefined) {
    themeInput = override.themeConfig;
  }

  const builtThemeStyle = buildSafeThemeStyleBlock(themeInput, resolvedThemeId);
  const themeStyle: SafeThemeStyleBlock =
    storedThemeMalformed && !(override && override.themeConfig !== undefined)
      ? {
          ...builtThemeStyle,
          fallbackUsed: true,
          fallbackReason: builtThemeStyle.fallbackReason ?? "MALFORMED_STORED_THEME_JSON",
        }
      : builtThemeStyle;

  const layoutMode = resolveSafeShellLayoutMode(
    options.layoutModeOverride ??
      (isPreview && override?.layoutMode !== undefined ? override.layoutMode : undefined) ??
      effectivePage?.layoutMode,
  );

  const siteTitle = effectiveSettings?.siteTitle ?? fallbackSiteTitle;
  const businessName = effectiveProfile?.businessName ?? effectiveSettings?.siteTitle ?? fallbackBusinessName;

  const effectiveBlogEnabled = effectiveSettings?.blogEnabled ?? true;
  const effectiveCatalogEnabled = effectiveSettings?.catalogEnabled ?? true;
  const effectiveEnabledOfferingTypes = effectiveCatalogEnabled
    ? (publishedGroupedReading?.enabledOfferingTypes ?? [...ALL_OFFERING_TYPES])
    : [];

  const sanitizedHeader = sanitizePublicMenuItems(effectiveHeaderItems);
  const sanitizedFooter = sanitizePublicMenuItems(effectiveFooterItems);
  const sanitizedMobile = sanitizePublicMenuItems(effectiveMobileItems);

  // Published navigation filtering (PLAN §11.2, TASK-040): hide disabled `/blog` and catalog/offering
  // links automatically on published public SSR renders; never mutate draft preview unless previewing
  // an explicit siteSettings draft override.
  const shouldFilterNavigation = !isPreview || Boolean(override?.siteSettings);
  const navReadingFilter = {
    blogEnabled: effectiveBlogEnabled,
    catalogEnabled: effectiveCatalogEnabled,
    enabledOfferingTypes: effectiveEnabledOfferingTypes,
  };

  return {
    isPreview,
    layoutMode,
    themeId: themeStyle.themeId,
    baseThemeId: themeStyle.baseThemeId,
    themeStyle,
    site: {
      title: siteTitle,
      tagline: effectiveSettings?.tagline ?? null,
      locale: effectiveSettings?.locale ?? "id-ID",
      timezone: effectiveSettings?.timezone ?? "Asia/Jakarta",
      blogEnabled: effectiveBlogEnabled,
      catalogEnabled: effectiveCatalogEnabled,
      siteVisibility: effectiveSettings?.siteVisibility ?? "public",
      analyticsConfig: effectiveSettings?.analyticsConfig ?? null,
    },
    business: {
      name: businessName,
      category: effectiveProfile?.businessCategory ?? "LocalBusiness",
      description: effectiveProfile?.description ?? null,
      address: effectiveProfile?.address ?? null,
      city: effectiveProfile?.city ?? null,
      province: effectiveProfile?.province ?? null,
      postalCode: effectiveProfile?.postalCode ?? null,
      mapsUrl: effectiveProfile?.mapsUrl ?? null,
      weekdayHours: effectiveProfile?.weekdayHours ?? null,
      holidayHours: effectiveProfile?.holidayHours ?? null,
      phone: effectiveProfile?.phone ?? null,
      whatsappE164: effectiveProfile?.whatsappE164 ?? null,
      email: effectiveProfile?.email ?? null,
      socialLinks: effectiveProfile?.socialLinks ?? [],
    },
    menus: {
      header: shouldFilterNavigation
        ? filterPublicNavigationForSettings(sanitizedHeader, navReadingFilter)
        : sanitizedHeader,
      footer: shouldFilterNavigation
        ? filterPublicNavigationForSettings(sanitizedFooter, navReadingFilter)
        : sanitizedFooter,
      mobile: shouldFilterNavigation
        ? filterPublicNavigationForSettings(sanitizedMobile, navReadingFilter)
        : sanitizedMobile,
    },
    page: effectivePage,
    outlets: publishedOutlets,
    revisions: {
      siteSettingsVersion: publishedSettings?.version ?? null,
      businessProfileVersion: publishedProfile?.version ?? null,
      themeConfigVersion: publishedTheme?.version ?? null,
      pageVersion: publishedPage?.version ?? null,
    },
  };
}
