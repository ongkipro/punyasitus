import type { PageSnapshot } from "@punyasitus/core/content/index";
import {
  computeContrastRatio,
  ensureAccessibleBrandColor,
  parseAndValidateThemeJson,
  sanitizeThemeColor,
  type AnyValidatedPageSection,
  type ClosedSectionType,
  type ThemeConfigSnapshot,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import { SECTION_REGISTRY_MAP } from "../../../../core/section-registry.ts";

/**
 * Pure runtime-neutral helper functions for the Theme Customizer UI & API
 * (TASK-034; REQ-037, REQ-019, REQ-020, REQ-036).
 *
 * Strictly zero DB, Cloudflare, or DOM-only dependencies so both server API
 * handlers, Astro SSR preview, client React island, and unit tests share ONE
 * canonical lossless implementation.
 */

export interface ColorContrastEvaluation {
  readonly valid: boolean;
  readonly normalizedHex: string | null;
  readonly contrastRatio: number | null;
  readonly passesAa: boolean;
  readonly adjusted: boolean;
  readonly suggestedHex: string | null;
  readonly adjustedContrastRatio: number | null;
  readonly warningMessage: string | null;
}

export const WCAG_AA_MIN_CONTRAST = 4.5 as const;

/**
 * Evaluates a candidate hex color against a background surface (default `#ffffff`)
 * using the canonical `@punyasitus/core/theme` WCAG 2.1 contrast engine.
 */
export function evaluateColorContrastStatus(
  rawHex: string,
  surfaceHex = "#ffffff",
): ColorContrastEvaluation {
  let normalizedSurface: string;
  try {
    normalizedSurface = sanitizeThemeColor(surfaceHex, "surfaceColor");
  } catch {
    normalizedSurface = "#ffffff";
  }

  let normalizedHex: string;
  try {
    normalizedHex = sanitizeThemeColor(rawHex, "color");
  } catch {
    return {
      valid: false,
      normalizedHex: null,
      contrastRatio: null,
      passesAa: false,
      adjusted: false,
      suggestedHex: null,
      adjustedContrastRatio: null,
      warningMessage: "Format warna harus berupa kode hex valid seperti #176b51 atau #0f4c5c.",
    };
  }

  const rawRatio = Number(computeContrastRatio(normalizedHex, normalizedSurface).toFixed(2));
  const accessible = ensureAccessibleBrandColor(
    normalizedHex,
    normalizedSurface,
    WCAG_AA_MIN_CONTRAST,
  );
  const passesAa = rawRatio >= WCAG_AA_MIN_CONTRAST;

  return {
    valid: true,
    normalizedHex,
    contrastRatio: rawRatio,
    passesAa,
    adjusted: accessible.adjusted,
    suggestedHex: accessible.color,
    adjustedContrastRatio: accessible.contrastRatio,
    warningMessage: passesAa
      ? null
      : `Rasio kontras ${rawRatio.toFixed(2)}:1 di bawah standar WCAG AA (4.5:1). Situs publik akan otomatis menyesuaikan ke ${accessible.color} (${accessible.contrastRatio.toFixed(2)}:1) agar teks tetap terbaca.`,
  };
}

/**
 * Validates theme tokens & variants via the canonical `parseAndValidateThemeJson`.
 */
export function validateThemeCustomizerTokens(
  themeId: string,
  tokens: ThemeTokens,
  variants: ThemeVariants,
):
  | { readonly ok: true; readonly snapshot: ThemeConfigSnapshot }
  | { readonly ok: false; readonly message: string } {
  try {
    const snapshot = parseAndValidateThemeJson(
      themeId,
      JSON.stringify(tokens),
      JSON.stringify(variants),
    );
    return { ok: true, snapshot };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Token tema tidak valid.",
    };
  }
}

export function getSectionLabelId(type: ClosedSectionType): string {
  return SECTION_REGISTRY_MAP[type]?.labelId ?? type;
}

export function getSectionHeadingPreview(section: AnyValidatedPageSection): string {
  const cfg = section.config as Record<string, unknown>;
  const heading = typeof cfg.heading === "string" ? cfg.heading.trim() : "";
  return heading || getSectionLabelId(section.type);
}

export interface SectionMutationResult {
  readonly sections: readonly AnyValidatedPageSection[];
  readonly changed: boolean;
  readonly announcement: string;
}

/**
 * Pure keyboard-accessible reorder helper: moves a section one step up (`Naik`)
 * or down (`Turun`), normalizes `order` indices, and returns an Indonesian
 * screen-reader announcement (`aria-live="polite"`).
 */
export function moveSectionInList(
  sections: readonly AnyValidatedPageSection[],
  index: number,
  direction: "up" | "down",
): SectionMutationResult {
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (
    index < 0 ||
    index >= sections.length ||
    targetIndex < 0 ||
    targetIndex >= sections.length
  ) {
    return { sections, changed: false, announcement: "" };
  }

  const next = [...sections];
  const moved = next[index];
  const swapped = next[targetIndex];
  if (!moved || !swapped) {
    return { sections, changed: false, announcement: "" };
  }

  next[index] = swapped;
  next[targetIndex] = moved;

  const normalized = next.map((item, idx) => ({
    ...item,
    order: idx,
  })) as AnyValidatedPageSection[];

  const label = getSectionLabelId(moved.type);
  const position = targetIndex + 1;
  return {
    sections: normalized,
    changed: true,
    announcement: `Bagian ${label} dipindahkan ke posisi ${position} dari ${normalized.length}.`,
  };
}

/**
 * Pure toggle helper: enables or disables a section by ID without deleting its
 * configuration, returning an Indonesian screen-reader announcement.
 */
export function toggleSectionInList(
  sections: readonly AnyValidatedPageSection[],
  sectionId: string,
  explicitEnabled?: boolean,
): SectionMutationResult {
  let changed = false;
  let targetLabel = "";
  let resolvedEnabled = false;

  const next = sections.map((item, idx) => {
    if (item.id !== sectionId) {
      return { ...item, order: idx };
    }
    const nextEnabled = explicitEnabled !== undefined ? explicitEnabled : !item.enabled;
    if (nextEnabled !== item.enabled) {
      changed = true;
    }
    targetLabel = getSectionLabelId(item.type);
    resolvedEnabled = nextEnabled;
    return {
      ...item,
      enabled: nextEnabled,
      order: idx,
    };
  }) as AnyValidatedPageSection[];

  if (!changed) {
    return { sections, changed: false, announcement: "" };
  }

  return {
    sections: next,
    changed: true,
    announcement: resolvedEnabled
      ? `Bagian ${targetLabel} ditampilkan di beranda.`
      : `Bagian ${targetLabel} disembunyikan dari beranda.`,
  };
}

/**
 * Applies a curated platform theme preset palette onto the current draft tokens
 * while clearing any stale `headingFontFamily` override (REQ-020 single custom font).
 */
export function applyPresetPaletteToTokens(
  current: ThemeTokens,
  presetTokens: ThemeTokens,
): ThemeTokens {
  const { headingFontFamily: _clearedHeadingFont, ...rest } = current;
  void _clearedHeadingFont;
  return {
    ...rest,
    primaryColor: presetTokens.primaryColor,
    secondaryColor: presetTokens.secondaryColor,
    accentColor: presetTokens.accentColor,
    surfaceColor: presetTokens.surfaceColor,
    textColor: presetTokens.textColor,
    borderRadiusPx: presetTokens.borderRadiusPx,
    fontFamily: presetTokens.fontFamily,
  };
}

// ---------------------------------------------------------------------------
// Single Canonical Lossless Section Registry <-> PageSnapshot Converter
// ---------------------------------------------------------------------------

type PublicSectionKind = PageSnapshot["sections"][number]["kind"];

function mapClosedTypeToPublicSectionKind(section: AnyValidatedPageSection): PublicSectionKind {
  switch (section.type) {
    case "features":
    case "highlights":
      return "rich_text";
    case "offerings_grid": {
      const offeringType = section.config.offeringType;
      if (offeringType === "product") return "products_grid";
      if (offeringType === "tour") return "tours_grid";
      if (offeringType === "vehicle") return "vehicles_grid";
      return "services_grid";
    }
    case "blog_latest":
      return "latest_posts";
    case "cta_banner":
      return "cta_band";
    case "contact_location":
      return "contact";
    default:
      return section.type;
  }
}

function escapeSimpleHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Single lossless converter transforming any `AnyValidatedPageSection` into a
 * `PublicPageSectionDto` compatible with `PageSnapshotSchema`, atomic publish,
 * SSR preview, and client live preview (preserving CTAs, `itemSlugs`, `formSlug`,
 * FAQ/features/team/testimonials items, and contact details).
 */
export function convertValidatedSectionToPublicDto(
  section: AnyValidatedPageSection,
): PageSnapshot["sections"][number] {
  const kind = mapClosedTypeToPublicSectionKind(section);
  const cfg = section.config as Record<string, unknown>;
  const heading = typeof cfg.heading === "string" ? cfg.heading : null;
  const subheading = typeof cfg.subheading === "string" ? cfg.subheading : null;

  let bodyHtml: string | null = null;
  let ctaLabel: string | null | undefined = undefined;
  let ctaHref: string | null | undefined = undefined;
  let formSlug: string | null | undefined = undefined;
  let itemSlugs: string[] | undefined = undefined;

  switch (section.type) {
    case "hero": {
      if (section.config.primaryCta) {
        ctaLabel = section.config.primaryCta.label;
        ctaHref = section.config.primaryCta.href;
      }
      if (section.config.highlights.length > 0) {
        bodyHtml = `<ul>${section.config.highlights.map((h) => `<li>${escapeSimpleHtml(h)}</li>`).join("")}</ul>`;
      }
      break;
    }
    case "rich_text":
    case "about": {
      bodyHtml = section.config.bodyHtml || null;
      if (section.config.cta) {
        ctaLabel = section.config.cta.label;
        ctaHref = section.config.cta.href;
      }
      break;
    }
    case "features":
    case "highlights":
    case "trust_logos":
    case "team": {
      if (section.config.items.length > 0) {
        bodyHtml = `<ul>${section.config.items
          .map(
            (item) =>
              `<li><strong>${escapeSimpleHtml(item.title)}</strong>${item.description ? ` — ${escapeSimpleHtml(item.description)}` : ""}</li>`,
          )
          .join("")}</ul>`;
      }
      break;
    }
    case "offerings_grid":
    case "services_grid":
    case "products_grid":
    case "tours_grid":
    case "vehicles_grid": {
      itemSlugs = [...section.config.itemSlugs];
      if (section.config.viewAllCta) {
        ctaLabel = section.config.viewAllCta.label;
        ctaHref = section.config.viewAllCta.href;
      }
      break;
    }
    case "testimonials": {
      if (section.config.items.length > 0) {
        bodyHtml = section.config.items
          .map(
            (t) =>
              `<blockquote><p>${escapeSimpleHtml(t.quote)}</p><footer>${escapeSimpleHtml(t.authorName)}</footer></blockquote>`,
          )
          .join("");
      }
      break;
    }
    case "faq": {
      if (section.config.items.length > 0) {
        bodyHtml = section.config.items
          .map(
            (f) =>
              `<p><strong>${escapeSimpleHtml(f.question)}</strong><br/>${escapeSimpleHtml(f.answer)}</p>`,
          )
          .join("");
      }
      break;
    }
    case "cta_banner":
    case "cta_band":
    case "custom_form": {
      ctaLabel = section.config.primaryCta.label;
      ctaHref = section.config.primaryCta.href;
      formSlug = section.config.formSlug ?? null;
      if (section.config.note) {
        bodyHtml = `<p>${escapeSimpleHtml(section.config.note)}</p>`;
      }
      break;
    }
    case "contact_location":
    case "contact":
    case "branches": {
      const parts: string[] = [];
      if (section.config.address) parts.push(`<p>${escapeSimpleHtml(section.config.address)}</p>`);
      if (section.config.weekdayHours) {
        parts.push(`<p>${escapeSimpleHtml(section.config.weekdayHours)}</p>`);
      }
      bodyHtml = parts.length > 0 ? parts.join("") : null;
      if (section.config.mapsUrl) {
        ctaLabel = section.config.mapsLabel;
        ctaHref = section.config.mapsUrl;
      }
      break;
    }
    case "blog_latest":
    case "latest_posts": {
      ctaLabel = section.config.viewAllLabel;
      ctaHref = section.config.viewAllHref;
      break;
    }
    case "gallery": {
      bodyHtml = null;
      break;
    }
  }

  return {
    id: section.id,
    kind,
    heading,
    subheading,
    bodyHtml,
    ...(ctaLabel !== undefined ? { ctaLabel } : {}),
    ...(ctaHref !== undefined ? { ctaHref } : {}),
    ...(formSlug !== undefined ? { formSlug } : {}),
    ...(itemSlugs !== undefined ? { itemSlugs } : {}),
  };
}

/**
 * Builds a clean `PageSnapshot` from validated sections containing ONLY enabled
 * sections in their exact display order. Shared by SSR preview, client live
 * preview, draft save, and atomic publish.
 */
export function buildHomepageSnapshotFromSections(
  sections: readonly AnyValidatedPageSection[],
  base: {
    readonly slug?: string;
    readonly title?: string;
    readonly layoutMode?: PageSnapshot["layoutMode"];
    readonly seo?: PageSnapshot["seo"];
  } = {},
): PageSnapshot {
  const enabledDtos = sections
    .filter((section) => section.enabled)
    .map((section) => convertValidatedSectionToPublicDto(section));

  return {
    slug: base.slug || "beranda",
    title: base.title || "Beranda",
    isHomepage: true,
    layoutMode: base.layoutMode ?? "standard",
    sections: enabledDtos,
    ...(base.seo !== undefined ? { seo: base.seo } : {}),
  };
}

/**
 * Deterministic signature of public enabled sections used to detect whether an
 * external homepage editor modified `pages.draft_sections_json` outside the
 * Theme Customizer so stale `_draftMetadata` never clobbers external edits.
 */
export function computePublicSectionsSignature(
  sections: PageSnapshot["sections"],
): string {
  return JSON.stringify(sections);
}
