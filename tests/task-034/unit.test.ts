import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePageSections } from "@punyasitus/core/theme/index";
import { PLATFORM_THEME_PRESETS } from "../../apps/web/src/core/public-data.ts";
import {
  applyPresetPaletteToTokens,
  buildHomepageSnapshotFromSections,
  evaluateColorContrastStatus,
  moveSectionInList,
  toggleSectionInList,
  validateThemeCustomizerTokens,
} from "../../apps/web/src/pages/dashboard/[handle]/appearance/_customizer-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function collectTsFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (/\.(?:ts|tsx|astro|js|mjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe("TASK-034: Theme Customizer Unit Tests", () => {
  it("validates valid theme tokens and rejects CSS injection / malformed hex / multiple custom fonts", () => {
    const validPreset = PLATFORM_THEME_PRESETS.compro;
    const okResult = validateThemeCustomizerTokens(
      "compro",
      validPreset.tokens,
      validPreset.variants,
    );
    expect(okResult.ok).toBe(true);

    // Malformed / XSS CSS injection payload must be rejected
    const xssResult = validateThemeCustomizerTokens(
      "compro",
      {
        ...validPreset.tokens,
        primaryColor: "#fff; } body { background: url(javascript:alert(1)) }",
      },
      validPreset.variants,
    );
    expect(xssResult.ok).toBe(false);

    // Out-of-bounds borderRadiusPx must be rejected
    const badRadius = validateThemeCustomizerTokens(
      "compro",
      {
        ...validPreset.tokens,
        borderRadiusPx: 99,
      },
      validPreset.variants,
    );
    expect(badRadius.ok).toBe(false);

    // REQ-020: at most one non-system custom font per site
    const twoCustomFonts = validateThemeCustomizerTokens(
      "compro",
      {
        ...validPreset.tokens,
        fontFamily: "inter",
        headingFontFamily: "lora",
      },
      validPreset.variants,
    );
    expect(twoCustomFonts.ok).toBe(false);
  });

  it("evaluates WCAG AA >= 4.5:1 contrast accurately and discloses auto-adjustment for low-contrast colors", () => {
    // Passing AA brand color (#176b51 on #ffffff)
    const passing = evaluateColorContrastStatus("#176b51", "#ffffff");
    expect(passing.valid).toBe(true);
    expect(passing.passesAa).toBe(true);
    expect(passing.adjusted).toBe(false);
    expect(passing.contrastRatio).toBeGreaterThanOrEqual(4.5);
    expect(passing.warningMessage).toBeNull();

    // Failing AA brand color (#facc15 yellow on #ffffff) -> warning + auto-adjusted AA suggestion
    const failing = evaluateColorContrastStatus("#facc15", "#ffffff");
    expect(failing.valid).toBe(true);
    expect(failing.passesAa).toBe(false);
    expect(failing.adjusted).toBe(true);
    expect(failing.contrastRatio).toBeLessThan(4.5);
    expect(failing.adjustedContrastRatio).toBeGreaterThanOrEqual(4.5);
    expect(failing.suggestedHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(failing.warningMessage).toContain("WCAG AA");

    // Malformed / unsafe color string
    const malformed = evaluateColorContrastStatus("javascript:alert(1)", "#ffffff");
    expect(malformed.valid).toBe(false);
    expect(malformed.passesAa).toBe(false);
    expect(malformed.warningMessage).toBeTruthy();
  });

  it("reorders sections deterministically via keyboard helpers and preserves full lossless section data in unified preview converter", () => {
    const validated = validatePageSections(
      [
        {
          id: "sec-hero",
          type: "hero",
          config: {
            heading: "Beranda Utama",
            primaryCta: { label: "Konsultasi", href: "#kontak", variant: "primary" },
            highlights: ["Cepat", "Aman"],
          },
        },
        {
          id: "sec-services",
          type: "services_grid",
          config: {
            heading: "Layanan Kami",
            offeringType: "service",
            itemSlugs: ["audit-seo", "renovation-office"],
            viewAllCta: { label: "Lihat Semua", href: "/layanan", variant: "secondary" },
          },
        },
        {
          id: "sec-faq",
          type: "faq",
          config: {
            heading: "FAQ",
            items: [{ question: "Berapa lama?", answer: "2 minggu kerja." }],
          },
        },
        {
          id: "sec-form",
          type: "custom_form",
          config: {
            heading: "Minta Penawaran",
            formSlug: "konsultasi-b2b",
            primaryCta: { label: "Kirim", href: "#form", variant: "primary" },
          },
        },
      ],
      { businessCategory: "LocalBusiness" },
    );

    // Move index 0 up -> safe no-op
    const noOpUp = moveSectionInList(validated.sections, 0, "up");
    expect(noOpUp.changed).toBe(false);

    // Move index 2 (faq) up -> index 1
    const movedUp = moveSectionInList(validated.sections, 2, "up");
    expect(movedUp.changed).toBe(true);
    expect(movedUp.sections.map((s) => s.id)).toEqual([
      "sec-hero",
      "sec-faq",
      "sec-services",
      "sec-form",
    ]);
    expect(movedUp.sections.map((s) => s.order)).toEqual([0, 1, 2, 3]);
    expect(movedUp.announcement).toContain("posisi 2 dari 4");

    // Move index 1 (faq) down -> back to index 2
    const movedDown = moveSectionInList(movedUp.sections, 1, "down");
    expect(movedDown.changed).toBe(true);
    expect(movedDown.sections.map((s) => s.id)).toEqual([
      "sec-hero",
      "sec-services",
      "sec-faq",
      "sec-form",
    ]);

    // Toggle `sec-faq` OFF -> stays in array with config intact, excluded from unified snapshot
    const toggledOff = toggleSectionInList(movedDown.sections, "sec-faq");
    expect(toggledOff.changed).toBe(true);
    expect(toggledOff.sections).toHaveLength(4);
    expect(toggledOff.sections.find((s) => s.id === "sec-faq")?.enabled).toBe(false);
    expect(toggledOff.announcement).toContain("disembunyikan");

    const previewPage = buildHomepageSnapshotFromSections(toggledOff.sections, {
      slug: "beranda",
      title: "Beranda",
    });
    expect(previewPage.sections.map((s) => s.id)).toEqual([
      "sec-hero",
      "sec-services",
      "sec-form",
    ]);
    // Lossless fields preserved in unified converter!
    const servicesDto = previewPage.sections.find((s) => s.id === "sec-services");
    expect(servicesDto?.itemSlugs).toEqual(["audit-seo", "renovation-office"]);
    expect(servicesDto?.ctaLabel).toBe("Lihat Semua");
    expect(servicesDto?.ctaHref).toBe("/layanan");

    const formDto = previewPage.sections.find((s) => s.id === "sec-form");
    expect(formDto?.formSlug).toBe("konsultasi-b2b");

    // Toggle `sec-faq` back ON and confirm FAQ Q&A bodyHtml is preserved
    const toggledOn = toggleSectionInList(toggledOff.sections, "sec-faq");
    const restoredPage = buildHomepageSnapshotFromSections(toggledOn.sections);
    const faqDto = restoredPage.sections.find((s) => s.id === "sec-faq");
    expect(faqDto?.bodyHtml).toContain("Berapa lama?");
    expect(faqDto?.bodyHtml).toContain("2 minggu kerja.");
  });

  it("applies preset palette shortcuts across all 6 platform themes and clears leftover headingFontFamily", () => {
    const baseWithHeadingFont = {
      ...PLATFORM_THEME_PRESETS.compro.tokens,
      headingFontFamily: "lora" as const,
    };
    for (const preset of Object.values(PLATFORM_THEME_PRESETS)) {
      const applied = applyPresetPaletteToTokens(baseWithHeadingFont, preset.tokens);
      expect(applied.primaryColor).toBe(preset.tokens.primaryColor);
      expect(applied.secondaryColor).toBe(preset.tokens.secondaryColor);
      expect(applied.borderRadiusPx).toBe(preset.tokens.borderRadiusPx);
      expect(applied.fontFamily).toBe("system");
      expect(applied.headingFontFamily).toBeUndefined();
    }
  });

  it("enforces zero @radix-ui/* imports, zero asChild usage, and no domain UI in TASK-034 scope", () => {
    const appearanceDir = path.join(REPO_ROOT, "apps/web/src/pages/dashboard/[handle]/appearance");
    const themeApiDir = path.join(REPO_ROOT, "apps/web/src/pages/api/tenants/[tenantId]/theme");
    const files = [...collectTsFiles(appearanceDir), ...collectTsFiles(themeApiDir)];

    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${file} must NEVER import @radix-ui/*`).not.toMatch(/@radix-ui\//);
      expect(src, `${file} must NEVER import radix-ui`).not.toMatch(/from\s+["']radix-ui["']/);
      expect(src, `${file} must NEVER use Radix asChild prop`).not.toMatch(/\basChild\b/);
    }
  });
});
