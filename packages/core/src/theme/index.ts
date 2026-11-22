import { z } from "zod";
import { ThemeIdSchema } from "../schemas/common.ts";

/**
 * Shared Theme Token & Variant Validation and Safe CSS Custom Property Emitter
 * (REQ-018, REQ-020, REQ-036, PLAN §7.3, TASK-027).
 *
 * Guarantees that malformed or hostile tenant theme configuration NEVER produces
 * executable CSS, arbitrary URLs, expressions, or HTML/CSS breakout syntax.
 */

export const PLATFORM_THEME_IDS = [
  "compro",
  "sales",
  "travel",
  "catalog",
  "resto",
  "dealer",
] as const;
export type PlatformThemeId = (typeof PLATFORM_THEME_IDS)[number];

/**
 * Closed allowlist of system and self-hosted font identifiers.
 * Public sites default to `"system"` and may load at most ONE non-system font (REQ-020).
 */
export const ALLOWED_THEME_FONTS = [
  "system",
  "plus-jakarta-sans",
  "inter",
  "dm-sans",
  "poppins",
  "manrope",
  "source-sans-3",
  "lora",
  "merriweather",
  "playfair-display",
] as const;
export type AllowedThemeFont = (typeof ALLOWED_THEME_FONTS)[number];

export const THEME_FONT_STACKS: Readonly<Record<AllowedThemeFont, string>> = {
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "plus-jakarta-sans": '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif',
  inter: '"Inter", system-ui, -apple-system, sans-serif',
  "dm-sans": '"DM Sans", system-ui, -apple-system, sans-serif',
  poppins: '"Poppins", system-ui, -apple-system, sans-serif',
  manrope: '"Manrope", system-ui, -apple-system, sans-serif',
  "source-sans-3": '"Source Sans 3", system-ui, -apple-system, sans-serif',
  lora: '"Lora", Georgia, Cambria, "Times New Roman", serif',
  merriweather: '"Merriweather", Georgia, Cambria, "Times New Roman", serif',
  "playfair-display": '"Playfair Display", Georgia, Cambria, "Times New Roman", serif',
};

export const HEADER_VARIANTS = ["standard", "centered", "minimal", "sticky-cta"] as const;
export type HeaderVariant = (typeof HEADER_VARIANTS)[number];

export const FOOTER_VARIANTS = ["columns", "compact", "centered"] as const;
export type FooterVariant = (typeof FOOTER_VARIANTS)[number];

export const HERO_VARIANTS = ["split", "centered", "banner", "minimal"] as const;
export type HeroVariant = (typeof HERO_VARIANTS)[number];

export const BUTTON_STYLES = ["solid", "outline", "soft"] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];

export const THEME_NUMERIC_BOUNDS = {
  borderRadiusPx: { min: 0, max: 32, default: 8 },
  spacingScale: { min: 0.75, max: 1.5, default: 1 },
  containerMaxWidthPx: { min: 960, max: 1440, default: 1200 },
  sectionPaddingYPx: { min: 16, max: 160, default: 64 },
} as const;

export interface ThemeValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class ThemeValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly ThemeValidationIssue[];

  constructor(message: string, fields: readonly ThemeValidationIssue[] = []) {
    super(message);
    this.name = "ThemeValidationError";
    this.fields = fields;
  }
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const STYLE_VARIANT_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const DANGEROUS_CSS_PATTERNS: readonly RegExp[] = [
  /url\s*\(/i,
  /expression\s*\(/i,
  /@import/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /behavior\s*:/i,
  /-moz-binding/i,
  /\/\*/,
  /\*\//,
  /[;{}<>\\"'`]/,
];

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Pure detector for CSS injection vectors: `url(`, `expression(`, `@import`,
 * comments, semicolons, braces, angle brackets, quotes, backslashes, and control chars.
 */
export function hasDangerousCssSyntax(value: string): boolean {
  if (hasControlChar(value)) return true;
  return DANGEROUS_CSS_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Validates and normalizes a 3- or 6-digit hex color to lowercase `#rrggbb`.
 * Rejects CSS functions, named colors, alpha hacks, and injection tokens.
 */
export function sanitizeThemeColor(raw: string, field = "color"): string {
  if (typeof raw !== "string") {
    throw new ThemeValidationError(`Invalid ${field}: expected hex color string`, [
      { field, code: "INVALID_COLOR", message: "Color must be a 3- or 6-digit hex string" },
    ]);
  }
  const trimmed = raw.trim();
  if (hasDangerousCssSyntax(trimmed) || !HEX_COLOR_RE.test(trimmed)) {
    throw new ThemeValidationError(`Unsafe or malformed hex color in ${field}`, [
      {
        field,
        code: "INVALID_HEX_COLOR",
        message: "Color must be a valid #rgb or #rrggbb hex value without CSS syntax",
      },
    ]);
  }
  const lower = trimmed.toLowerCase();
  if (lower.length === 4) {
    const r = lower.charAt(1);
    const g = lower.charAt(2);
    const b = lower.charAt(3);
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
}

const SafeHexColorSchema = z.string().superRefine((val, ctx) => {
  const trimmed = val.trim();
  if (hasDangerousCssSyntax(trimmed) || !HEX_COLOR_RE.test(trimmed)) {
    ctx.addIssue({
      code: "custom",
      message: "Must be a valid #rgb or #rrggbb hex color without CSS injection syntax",
    });
  }
}).transform((val) => sanitizeThemeColor(val));

const SafeFontSchema = z.enum(ALLOWED_THEME_FONTS);

const SafeStyleVariantSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((val) => !hasDangerousCssSyntax(val) && STYLE_VARIANT_RE.test(val), {
    message: "Style variant must be lowercase alphanumeric/hyphens without CSS syntax",
  });

export const ThemeTokensSchema = z
  .object({
    primaryColor: SafeHexColorSchema,
    secondaryColor: SafeHexColorSchema,
    accentColor: SafeHexColorSchema.optional(),
    surfaceColor: SafeHexColorSchema.optional(),
    textColor: SafeHexColorSchema.optional(),
    fontFamily: SafeFontSchema.default("system"),
    headingFontFamily: SafeFontSchema.optional(),
    borderRadiusPx: z
      .number()
      .int()
      .min(THEME_NUMERIC_BOUNDS.borderRadiusPx.min)
      .max(THEME_NUMERIC_BOUNDS.borderRadiusPx.max)
      .default(THEME_NUMERIC_BOUNDS.borderRadiusPx.default),
    spacingScale: z
      .number()
      .finite()
      .min(THEME_NUMERIC_BOUNDS.spacingScale.min)
      .max(THEME_NUMERIC_BOUNDS.spacingScale.max)
      .default(THEME_NUMERIC_BOUNDS.spacingScale.default),
    containerMaxWidthPx: z
      .number()
      .int()
      .min(THEME_NUMERIC_BOUNDS.containerMaxWidthPx.min)
      .max(THEME_NUMERIC_BOUNDS.containerMaxWidthPx.max)
      .default(THEME_NUMERIC_BOUNDS.containerMaxWidthPx.default),
    sectionPaddingYPx: z
      .number()
      .int()
      .min(THEME_NUMERIC_BOUNDS.sectionPaddingYPx.min)
      .max(THEME_NUMERIC_BOUNDS.sectionPaddingYPx.max)
      .default(THEME_NUMERIC_BOUNDS.sectionPaddingYPx.default),
    fastestSystemFont: z.boolean().default(false),
  })
  .strict()
  .superRefine((tokens, ctx) => {
    const bodyFont = tokens.fontFamily;
    const headingFont = tokens.headingFontFamily ?? bodyFont;
    // REQ-020: at most one non-system self-hosted custom font per theme
    if (bodyFont !== "system" && headingFont !== "system" && bodyFont !== headingFont) {
      ctx.addIssue({
        code: "custom",
        path: ["headingFontFamily"],
        message: "At most one non-system custom font is allowed per site (REQ-020)",
      });
    }
  });

export const ThemeVariantsSchema = z
  .object({
    styleVariant: SafeStyleVariantSchema.default("default"),
    headerVariant: z.enum(HEADER_VARIANTS).default("standard"),
    footerVariant: z.enum(FOOTER_VARIANTS).default("columns"),
    heroVariant: z.enum(HERO_VARIANTS).default("split"),
    buttonStyle: z.enum(BUTTON_STYLES).default("solid"),
  })
  .strict();

export const ThemeConfigSnapshotSchema = z
  .object({
    themeId: ThemeIdSchema,
    tokens: ThemeTokensSchema,
    variants: ThemeVariantsSchema,
  })
  .strict();

export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
export type ThemeVariants = z.infer<typeof ThemeVariantsSchema>;
export type ThemeConfigSnapshot = z.infer<typeof ThemeConfigSnapshotSchema>;

function toThemeValidationError(prefix: string, error: z.ZodError): ThemeValidationError {
  const fields: ThemeValidationIssue[] = error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : prefix,
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
  return new ThemeValidationError(`${prefix} validation failed`, fields);
}

export function validateThemeTokens(input: unknown): ThemeTokens {
  const parsed = ThemeTokensSchema.safeParse(input);
  if (!parsed.success) {
    throw toThemeValidationError("tokens", parsed.error);
  }
  return parsed.data;
}

export function validateThemeVariants(input: unknown): ThemeVariants {
  const parsed = ThemeVariantsSchema.safeParse(input);
  if (!parsed.success) {
    throw toThemeValidationError("variants", parsed.error);
  }
  return parsed.data;
}

export function validateThemeConfigSnapshot(input: unknown): ThemeConfigSnapshot {
  const parsed = ThemeConfigSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw toThemeValidationError("theme_config", parsed.error);
  }
  return parsed.data;
}

/**
 * Parses and strictly validates raw `tokens_json` and `variants_json` columns
 * from `TenantStore.theme_configs`.
 */
export function parseAndValidateThemeJson(
  themeId: string,
  tokensJson: string,
  variantsJson: string,
): ThemeConfigSnapshot {
  let rawTokens: unknown;
  let rawVariants: unknown;
  try {
    rawTokens = JSON.parse(tokensJson);
  } catch {
    throw new ThemeValidationError("Malformed JSON in tokens_json", [
      { field: "tokens_json", code: "INVALID_JSON", message: "tokens_json must be valid JSON" },
    ]);
  }
  try {
    rawVariants = JSON.parse(variantsJson);
  } catch {
    throw new ThemeValidationError("Malformed JSON in variants_json", [
      { field: "variants_json", code: "INVALID_JSON", message: "variants_json must be valid JSON" },
    ]);
  }
  return validateThemeConfigSnapshot({
    themeId,
    tokens: rawTokens,
    variants: rawVariants,
  });
}

function parseHexRgb(hex6: string): readonly [number, number, number] {
  const clean = sanitizeThemeColor(hex6);
  return [
    Number.parseInt(clean.slice(1, 3), 16),
    Number.parseInt(clean.slice(3, 5), 16),
    Number.parseInt(clean.slice(5, 7), 16),
  ];
}

function channelLuminance(channel255: number): number {
  const s = channel255 / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex6: string): number {
  const [r, g, b] = parseHexRgb(hex6);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * Computes WCAG 2.1 contrast ratio between two hex colors (1.0 to 21.0).
 */
export function computeContrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

export interface AccessibleBrandColorResult {
  readonly color: string;
  readonly originalColor: string;
  readonly adjusted: boolean;
  readonly contrastRatio: number;
}

/**
 * Enforces WCAG AA >= 4.5:1 contrast for brand colors against a background surface
 * (default `#ffffff`) and discloses whether adjustment occurred (REQ-020).
 */
export function ensureAccessibleBrandColor(
  rawColor: string,
  backgroundHex = "#ffffff",
  minRatio = 4.5,
): AccessibleBrandColorResult {
  const originalColor = sanitizeThemeColor(rawColor, "primaryColor");
  const bg = sanitizeThemeColor(backgroundHex, "surfaceColor");
  const initialRatio = computeContrastRatio(originalColor, bg);
  if (initialRatio >= minRatio) {
    return {
      color: originalColor,
      originalColor,
      adjusted: false,
      contrastRatio: Number(initialRatio.toFixed(2)),
    };
  }

  const bgLum = relativeLuminance(bg);
  const darken = bgLum >= 0.5;
  const [r0, g0, b0] = parseHexRgb(originalColor);
  let bestColor = darken ? "#000000" : "#ffffff";
  let bestRatio = computeContrastRatio(bestColor, bg);

  for (let step = 1; step <= 40; step += 1) {
    const t = step / 40;
    const target = darken ? 0 : 255;
    const candidate = rgbToHex(
      r0 + (target - r0) * t,
      g0 + (target - g0) * t,
      b0 + (target - b0) * t,
    );
    const ratio = computeContrastRatio(candidate, bg);
    if (ratio >= minRatio) {
      bestColor = candidate;
      bestRatio = ratio;
      break;
    }
  }

  return {
    color: bestColor,
    originalColor,
    adjusted: true,
    contrastRatio: Number(bestRatio.toFixed(2)),
  };
}

/**
 * Emits a guaranteed-safe CSS `:root` custom property block from validated theme config.
 * Re-validates defensively so malformed input can never produce executable CSS.
 */
export function renderThemeCssCustomProperties(snapshot: ThemeConfigSnapshot): string {
  const validated = validateThemeConfigSnapshot(snapshot);
  const { tokens } = validated;

  const surface = tokens.surfaceColor ?? "#ffffff";
  const text = tokens.textColor ?? "#111827";
  const primary = ensureAccessibleBrandColor(tokens.primaryColor, surface).color;
  const secondary = ensureAccessibleBrandColor(tokens.secondaryColor, surface).color;
  const accent = tokens.accentColor
    ? ensureAccessibleBrandColor(tokens.accentColor, surface).color
    : secondary;

  const effectiveBodyFont: AllowedThemeFont = tokens.fastestSystemFont ? "system" : tokens.fontFamily;
  const effectiveHeadingFont: AllowedThemeFont = tokens.fastestSystemFont
    ? "system"
    : (tokens.headingFontFamily ?? tokens.fontFamily);

  const declarations = [
    `--ps-color-primary: ${primary}`,
    `--ps-color-secondary: ${secondary}`,
    `--ps-color-accent: ${accent}`,
    `--ps-color-surface: ${surface}`,
    `--ps-color-text: ${text}`,
    `--ps-font-body: ${THEME_FONT_STACKS[effectiveBodyFont]}`,
    `--ps-font-heading: ${THEME_FONT_STACKS[effectiveHeadingFont]}`,
    `--ps-radius-base: ${tokens.borderRadiusPx}px`,
    `--ps-spacing-scale: ${Number(tokens.spacingScale.toFixed(3))}`,
    `--ps-container-max-width: ${tokens.containerMaxWidthPx}px`,
    `--ps-section-padding-y: ${tokens.sectionPaddingYPx}px`,
  ];

  return `:root { ${declarations.join("; ")}; }`;
}
