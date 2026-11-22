import fs from "node:fs";
import path from "node:path";
import { computeContrastRatio, PLATFORM_THEME_IDS } from "@punyasitus/core/theme/index";
import { describe, expect, it } from "vitest";
import {
  buildSafeThemeStyleBlock,
  loadPublishedTenantShellData,
  PLATFORM_THEME_PRESETS,
  resolveSafeShellLayoutMode,
  sanitizePublicMenuItems,
} from "../../apps/web/src/core/public-data.ts";

const root = path.resolve(import.meta.dirname, "../..");
const webSrcDir = path.join(root, "apps/web/src");

describe("TASK-012: Shared Theme Base Shell & Dynamic Token Injection (Unit)", () => {
  it("emits WCAG AA (>= 4.5:1) custom properties and system font defaults for all 6 platform themes", () => {
    for (const themeId of PLATFORM_THEME_IDS) {
      const preset = PLATFORM_THEME_PRESETS[themeId];
      expect(preset).toBeDefined();

      const block = buildSafeThemeStyleBlock(null, themeId);
      expect(block.fallbackUsed).toBe(false);
      expect(block.themeId).toBe(themeId);
      expect(block.baseThemeId).toBe(themeId);

      // Required storefront custom properties
      expect(block.css).toContain("--ps-brand-primary:");
      expect(block.css).toContain("--ps-brand-secondary:");
      expect(block.css).toContain("--ps-surface:");
      expect(block.css).toContain("--ps-surface-muted:");
      expect(block.css).toContain("--ps-ink:");
      expect(block.css).toContain("--ps-ink-muted:");
      expect(block.css).toContain("--ps-border:");
      expect(block.css).toContain("--ps-radius:");
      expect(block.css).toContain("--ps-font-sans:");
      expect(block.css).toContain("--ps-container-max:");

      // REQ-020: default system font stack
      expect(block.tokens.fontFamily).toBe("system");
      expect(block.css).toContain("system-ui");

      // WCAG AA >= 4.5:1 verified contrast on surface and on-primary/on-secondary buttons
      expect(computeContrastRatio(block.contrast.primaryResolved, block.palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(computeContrastRatio(block.contrast.secondaryResolved, block.palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(computeContrastRatio(block.palette.ink, block.palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(computeContrastRatio(block.palette.inkMuted, block.palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(
        computeContrastRatio(block.contrast.onPrimary, block.contrast.primaryResolved),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("automatically adjusts low-contrast brand colors to >= 4.5:1 and discloses the adjustment (REQ-020)", () => {
    const block = buildSafeThemeStyleBlock(
      {
        primaryColor: "#facc15", // bright yellow (~1.5:1 on white)
        secondaryColor: "#bef264", // light lime (~1.4:1 on white)
        surfaceColor: "#ffffff",
      },
      "sales",
    );

    expect(block.fallbackUsed).toBe(false);
    expect(block.contrast.primaryAdjusted).toBe(true);
    expect(block.contrast.primaryOriginal).toBe("#facc15");
    expect(block.contrast.primaryRatio).toBeGreaterThanOrEqual(4.5);
    expect(block.contrast.secondaryAdjusted).toBe(true);
    expect(block.contrast.secondaryRatio).toBeGreaterThanOrEqual(4.5);
    expect(block.css).toContain(`--ps-brand-primary: ${block.contrast.primaryResolved}`);
  });

  it("blocks CSS injection vectors and falls back safely without executable CSS or HTML breakout", () => {
    const maliciousInputs: unknown[] = [
      {
        primaryColor: "#112233</style><script>window.__xss=1</script>",
        secondaryColor: "#0f766e",
      },
      {
        primaryColor: "#112233; background-image: url(https://evil.example/a.png)",
        secondaryColor: "#0f766e",
      },
      {
        primaryColor: "expression(alert(1))",
        secondaryColor: "#0f766e",
      },
      {
        primaryColor: "#112233} body{display:none!important",
        secondaryColor: "#0f766e",
      },
      {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        fontFamily: "system; @import url(https://evil.example/evil.css)",
      },
      {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        borderRadiusPx: 9999,
      },
      {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        injectedUnknownKey: "url(https://evil.example/track)",
      },
      '{"primaryColor":"#112233; url(evil)"}',
      "not-even-json}</style><script>alert(1)</script>",
      {
        tokensJson: '{"primaryColor":"#176b51;</style><script>alert(1)</script>"}',
        variantsJson: "{}",
      },
    ];

    for (const payload of maliciousInputs) {
      const result = buildSafeThemeStyleBlock(payload, "compro");
      expect(result.fallbackUsed).toBe(true);
      expect(result.fallbackReason).toBeTruthy();

      // Must never contain any breakout or executable CSS vector
      expect(result.css.toLowerCase()).not.toContain("</style");
      expect(result.css.toLowerCase()).not.toContain("<script");
      expect(result.css.toLowerCase()).not.toContain("url(");
      expect(result.css.toLowerCase()).not.toContain("expression(");
      expect(result.css.toLowerCase()).not.toContain("@import");
      expect(result.css.toLowerCase()).not.toContain("javascript:");
      expect(result.css).not.toContain("evil.example");

      // Safe preset color restored
      expect(result.css).toContain(
        `--ps-brand-primary: ${PLATFORM_THEME_PRESETS.compro.tokens.primaryColor}`,
      );
    }
  });

  it("enforces fastestSystemFont override even when a custom font is configured (REQ-020)", () => {
    const customFontBlock = buildSafeThemeStyleBlock(
      {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        fontFamily: "plus-jakarta-sans",
        fastestSystemFont: false,
      },
      "compro",
    );
    expect(customFontBlock.css).toContain('"Plus Jakarta Sans"');

    const fastestBlock = buildSafeThemeStyleBlock(
      {
        primaryColor: "#176b51",
        secondaryColor: "#0f4c5c",
        fontFamily: "plus-jakarta-sans",
        fastestSystemFont: true,
      },
      "compro",
    );
    expect(fastestBlock.css).not.toContain('"Plus Jakarta Sans"');
    expect(fastestBlock.css).toContain("system-ui");
  });

  it("resolves standard vs focused Landing Page Focus Mode safely", () => {
    expect(resolveSafeShellLayoutMode("standard")).toBe("standard");
    expect(resolveSafeShellLayoutMode("focused")).toBe("focused");
    expect(resolveSafeShellLayoutMode(undefined)).toBe("standard");
    expect(resolveSafeShellLayoutMode(null)).toBe("standard");
    expect(resolveSafeShellLayoutMode("unknown")).toBe("standard");
    expect(resolveSafeShellLayoutMode("focused; drop table")).toBe("standard");
  });

  it("sanitizes menu items and drops unsafe javascript/data/protocol-relative hrefs", () => {
    const cleaned = sanitizePublicMenuItems([
      {
        label: "Beranda",
        href: "/",
        openInNewTab: false,
        children: [
          {
            label: "Aman",
            href: "/layanan",
            openInNewTab: false,
            children: [
              { label: "XSS", href: "javascript:alert(1)", openInNewTab: false },
              { label: "Kontak", href: "#kontak", openInNewTab: false },
            ],
          },
          {
            label: "Bad Data",
            href: "data:text/html,<script>alert(1)</script>",
            openInNewTab: false,
            children: [],
          },
        ],
      },
      {
        label: "Protocol Relative",
        href: "//evil.example/phish",
        openInNewTab: true,
        children: [],
      },
      {
        label: "WhatsApp",
        href: "https://wa.me/6281234567890",
        openInNewTab: true,
        children: [],
      },
    ]);

    expect(cleaned).toHaveLength(2);
    expect(cleaned[0]?.href).toBe("/");
    expect(cleaned[0]?.children).toHaveLength(1);
    expect(cleaned[0]?.children[0]?.children).toHaveLength(1);
    expect(cleaned[0]?.children[0]?.children[0]?.href).toBe("#kontak");
    expect(cleaned[1]?.href).toBe("https://wa.me/6281234567890");
  });

  it("ignores previewDraftOverride unless previewMode is explicitly true", async () => {
    const publicShell = await loadPublishedTenantShellData(null, {
      fallbackSiteTitle: "Situs Publik Aman",
      previewMode: false,
      previewDraftOverride: {
        siteSettings: {
          siteTitle: "DRAFT RAHASIA",
          activeThemeId: "dealer",
          timezone: "Asia/Jakarta",
          locale: "id-ID",
          blogEnabled: true,
          catalogEnabled: true,
          aiTrainingPolicy: "allow",
          siteVisibility: "public",
        },
        layoutMode: "focused",
      },
    });
    expect(publicShell.isPreview).toBe(false);
    expect(publicShell.site.title).toBe("Situs Publik Aman");
    expect(publicShell.layoutMode).toBe("standard");

    const previewShell = await loadPublishedTenantShellData(null, {
      fallbackSiteTitle: "Situs Publik Aman",
      previewMode: true,
      previewDraftOverride: {
        siteSettings: {
          siteTitle: "Pratinjau Draf Resmi",
          activeThemeId: "travel",
          timezone: "Asia/Jakarta",
          locale: "id-ID",
          blogEnabled: true,
          catalogEnabled: true,
          aiTrainingPolicy: "allow",
          siteVisibility: "public",
          draftNotes: "MUST BE STRIPPED",
        },
        layoutMode: "focused",
      },
    });
    expect(previewShell.isPreview).toBe(true);
    expect(previewShell.site.title).toBe("Pratinjau Draf Resmi");
    expect(previewShell.themeId).toBe("travel");
    expect(previewShell.layoutMode).toBe("focused");
    expect(JSON.stringify(previewShell)).not.toContain("MUST BE STRIPPED");
  });

  it("keeps themes/default/Layout.astro strictly isolated from admin CSS, @base-ui/react, and @radix-ui/*", () => {
    const layoutSource = fs.readFileSync(
      path.join(webSrcDir, "themes/default/Layout.astro"),
      "utf8",
    );
    expect(layoutSource).not.toContain("@radix-ui/");
    expect(layoutSource).not.toContain("asChild");
    expect(layoutSource).not.toContain("@base-ui/react");
    expect(layoutSource).not.toContain("styles/admin");
    expect(layoutSource).not.toContain("components/ui");

    // Required shell slots & contracts
    expect(layoutSource).toContain('<style is:inline set:html={safeTheme.css} />');
    expect(layoutSource).toContain('<slot name="head" />');
    expect(layoutSource).toContain('<slot name="floating" />');
    expect(layoutSource).toContain("Lewati ke konten utama");
    expect(layoutSource).toContain("<Consent");
  });
});
