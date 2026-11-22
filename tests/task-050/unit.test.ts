import fs from "node:fs";
import path from "node:path";
import {
  assertWithinPreviewByteCap,
  buildPreviewResponseHeaders,
  extractReferencedMediaIds,
  MAX_PREVIEW_REQUEST_BYTES,
  neutralizePreviewHtml,
  PREVIEW_CACHE_CONTROL_HEADER,
  PREVIEW_FORBIDDEN_SELECTOR_KEYS,
  PREVIEW_HEADER_NAME,
  PREVIEW_HTML_CSP_HEADER,
  PREVIEW_IFRAME_SANDBOX,
  PREVIEW_PRAGMA_HEADER,
  PREVIEW_ROBOTS_HEADER,
  PREVIEW_VIEWPORTS,
  PreviewPayloadTooLargeError,
  PreviewValidationError,
  validateDraftPreviewInput,
} from "@punyasitus/core/preview/index";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("TASK-050: Bounded Draft Preview DTO, Inert Neutralizer & Header Policy (Unit)", () => {
  it("validates strict bounded preview inputs across all supported resource kinds", () => {
    const pageInput = validateDraftPreviewInput({
      resourceKind: "page",
      resourceId: 4,
      expectedVersion: 2,
      themeId: "compro",
      layoutMode: "focused",
    });
    expect(pageInput.resourceKind).toBe("page");
    expect(pageInput.resourceId).toBe(4);
    expect(pageInput.expectedVersion).toBe(2);
    expect(pageInput.themeId).toBe("compro");
    expect(pageInput.layoutMode).toBe("focused");

    const homeInput = validateDraftPreviewInput({
      resourceKind: "home",
      version: 1,
    });
    expect(homeInput.resourceKind).toBe("home");
    expect(homeInput.expectedVersion).toBe(1);

    const offeringOverride = validateDraftPreviewInput({
      resourceKind: "offering",
      draftOverride: {
        offering: {
          offeringType: "service",
          slug: "audit-seo-b2b",
          title: "Audit SEO B2B",
          summary: "Audit menyeluruh",
          priceMode: "fixed",
          price: 2_500_000,
          negotiable: false,
          ctaMode: "whatsapp",
          galleryMediaIds: [11, 12],
          attributesVersion: 1,
          attributes: {},
        },
      },
    });
    expect(offeringOverride.draftOverride?.offering?.title).toBe("Audit SEO B2B");
  });

  it("enforces the 128 KiB hard byte cap with 413 PreviewPayloadTooLargeError", () => {
    const oversizedBody = "a".repeat(MAX_PREVIEW_REQUEST_BYTES + 1);
    expect(() => assertWithinPreviewByteCap(oversizedBody)).toThrow(PreviewPayloadTooLargeError);

    expect(() =>
      validateDraftPreviewInput({
        resourceKind: "home",
        draftOverride: {
          page: {
            slug: "beranda",
            title: "Beranda",
            isHomepage: true,
            layoutMode: "standard",
            sections: [
              {
                id: "s1",
                kind: "rich_text",
                heading: "Besar",
                subheading: null,
                bodyHtml: `<p>${"x".repeat(49_000)}</p>`,
              },
              {
                id: "s2",
                kind: "rich_text",
                heading: "Besar 2",
                subheading: null,
                bodyHtml: `<p>${"y".repeat(49_000)}</p>`,
              },
              {
                id: "s3",
                kind: "rich_text",
                heading: "Besar 3",
                subheading: null,
                bodyHtml: `<p>${"z".repeat(40_000)}</p>`,
              },
            ],
          },
        },
      }),
    ).toThrow(PreviewPayloadTooLargeError);
  });

  it("rejects forbidden tenant, user, owner, and role selector keys anywhere in payload", () => {
    const requiredForbiddenKeys = [
      "tenantId",
      "tenant_id",
      "organizationId",
      "userId",
      "ownerId",
      "role",
    ];
    for (const key of requiredForbiddenKeys) {
      expect(PREVIEW_FORBIDDEN_SELECTOR_KEYS).toContain(key);
      expect(() =>
        validateDraftPreviewInput({
          resourceKind: "home",
          [key]: "forged-value",
        }),
      ).toThrow(PreviewValidationError);

      expect(() =>
        validateDraftPreviewInput({
          resourceKind: "home",
          draftOverride: {
            page: {
              slug: "beranda",
              title: "Test",
              isHomepage: true,
              layoutMode: "standard",
              sections: [],
              [key]: "nested-forged",
            },
          },
        }),
      ).toThrow(PreviewValidationError);
    }
  });

  it("rejects unknown fields, conflicting version/expectedVersion, and unsafe URLs", () => {
    expect(() =>
      validateDraftPreviewInput({
        resourceKind: "home",
        unexpectedExtraField: true,
      }),
    ).toThrow(PreviewValidationError);

    expect(() =>
      validateDraftPreviewInput({
        resourceKind: "page",
        resourceId: 1,
        version: 2,
        expectedVersion: 3,
      }),
    ).toThrow(PreviewValidationError);

    expect(() =>
      validateDraftPreviewInput({
        resourceKind: "page",
        resourceId: 1,
        draftOverride: {
          page: {
            slug: "promo",
            title: "Promo",
            isHomepage: false,
            layoutMode: "standard",
            sections: [
              {
                id: "hero-1",
                kind: "hero",
                heading: "Promo",
                subheading: null,
                bodyHtml: null,
                ctaLabel: "Klik",
                ctaHref: "javascript:alert(1)",
              },
            ],
          },
        },
      }),
    ).toThrow(PreviewValidationError);

    expect(() =>
      validateDraftPreviewInput({
        resourceKind: "menu",
        draftOverride: {
          menu: {
            location: "header",
            items: [
              {
                label: "Jahat",
                href: "//evil.example/phish",
                openInNewTab: false,
                children: [],
              },
            ],
          },
        },
      }),
    ).toThrow(PreviewValidationError);
  });

  it("extracts every referenced mediaId across page, post, offering, siteSettings, and extraMediaIds", () => {
    const refs = extractReferencedMediaIds({
      siteSettings: {
        siteTitle: "Studio",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
        faviconMediaId: 10,
        ogImageMediaId: 11,
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
      },
      page: {
        slug: "beranda",
        title: "Beranda",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
        seo: { ogImageMediaId: 12 },
      },
      post: {
        slug: "tips",
        title: "Tips",
        body: {
          schemaVersion: 1,
          blocks: [
            { type: "paragraph", text: "Halo" },
            { type: "image", mediaId: 13 },
          ],
        },
        coverMediaId: 14,
        readingTimeMinutes: 3,
        showToc: false,
      },
      offering: {
        offeringType: "product",
        slug: "kopi",
        title: "Kopi",
        coverMediaId: 15,
        galleryMediaIds: [16, 17],
        videoMediaId: 18,
        priceMode: "on_request",
        negotiable: false,
        ctaMode: "whatsapp",
        attributesVersion: 1,
        attributes: {},
      },
      extraMediaIds: [19],
    });

    const ids = refs.map((r) => r.mediaId).sort((a, b) => a - b);
    expect(ids).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("neutralizes scripts, tracking noscript, iframes, inline handlers, forms, and external links", () => {
    const rawHtml = `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <link rel="canonical" href="https://alpha.situsku.click/beranda" />
    <meta http-equiv="refresh" content="0;url=https://evil.example" />
    <script src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX"></script>
    <script>window.__xssExecuted = true;</script>
  </head>
  <body onload="alert(1)">
    <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXXX"></iframe></noscript>
    <a href="#main-content" class="ps-skip-link">Lewati ke konten utama</a>
    <a href="https://evil.example/out" target="_blank" onclick="steal()">Kunjungi Eksternal</a>
    <a href="/layanan">Layanan Kami</a>
    <form action="https://evil.example/submit" method="POST" onsubmit="steal()">
      <input type="text" name="email" />
      <button type="submit" formaction="https://evil.example/alt">Kirim</button>
    </form>
    <iframe src="https://maps.google.com/embed"></iframe>
  </body>
</html>`;

    const inert = neutralizePreviewHtml(rawHtml);

    // Zero scripts, iframes, noscript trackers, refresh redirects, canonical, or event handlers
    expect(inert.toLowerCase()).not.toContain("<script");
    expect(inert.toLowerCase()).not.toContain("<iframe");
    expect(inert.toLowerCase()).not.toContain("<noscript");
    expect(inert.toLowerCase()).not.toContain("googletagmanager");
    expect(inert.toLowerCase()).not.toContain("rel=\"canonical\"");
    expect(inert.toLowerCase()).not.toContain("http-equiv=\"refresh\"");
    expect(inert.toLowerCase()).not.toContain("onload=");
    expect(inert.toLowerCase()).not.toContain("onclick=");
    expect(inert.toLowerCase()).not.toContain("onsubmit=");

    // Forms and submit controls are neutralized
    expect(inert).toContain('data-preview-inert="form"');
    expect(inert).not.toMatch(/\baction\s*=\s*"https:\/\/evil\.example/i);
    expect(inert).not.toMatch(/\bformaction\s*=/i);
    expect(inert).toContain('disabled data-preview-inert="submit"');

    // External and path links are neutralized while in-page #main-content skip link remains intact
    expect(inert).toContain('href="#main-content"');
    expect(inert).toContain('data-preview-inert="link"');
    expect(inert).toContain('data-preview-href="https://evil.example/out"');
    expect(inert).toContain('data-preview-href="/layanan"');
    expect(inert).not.toMatch(/\shref\s*=\s*"https:\/\/evil\.example/i);
    expect(inert).not.toMatch(/\shref\s*=\s*"\/layanan"/i);

    // Robots noindex + preview CSP meta injected
    expect(inert).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(inert).toContain('http-equiv="Content-Security-Policy"');
    expect(inert).toContain("script-src 'none'");
    expect(inert).toContain("form-action 'none'");
  });

  it("emits mandatory uncacheable, non-indexable, restrictive-CSP preview headers and empty sandbox", () => {
    const headers = buildPreviewResponseHeaders({ contentType: "text/html; charset=utf-8" });
    expect(headers.get("Cache-Control")).toBe(PREVIEW_CACHE_CONTROL_HEADER);
    expect(headers.get("Pragma")).toBe(PREVIEW_PRAGMA_HEADER);
    expect(headers.get("X-Robots-Tag")).toBe(PREVIEW_ROBOTS_HEADER);
    expect(headers.get(PREVIEW_HEADER_NAME)).toBe("1");
    expect(headers.get("X-PunyaSitus-Cache")).toBe("BYPASS");
    expect(headers.get("Content-Security-Policy")).toBe(PREVIEW_HTML_CSP_HEADER);
    expect(headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("form-action 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(PREVIEW_IFRAME_SANDBOX).toBe("");

    expect(PREVIEW_VIEWPORTS.mobile.widthPx).toBe(360);
    expect(PREVIEW_VIEWPORTS.tablet.widthPx).toBe(768);
    expect(PREVIEW_VIEWPORTS.desktop.widthPx).toBe(1440);
  });

  it("uses Layout.astro in-process and enforces DEC-036 (zero @radix-ui/* or asChild) in preview files", () => {
    const files = [
      "apps/web/src/core/preview/PreviewThemeDocument.astro",
      "apps/web/src/core/preview/astro-renderer.ts",
      "apps/web/src/pages/dashboard/[handle]/preview/_AdminPreviewShell.tsx",
      "apps/web/src/pages/dashboard/[handle]/preview/index.astro",
      "apps/web/src/pages/dashboard/[handle]/preview/frame.astro",
    ];

    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      expect(src).not.toContain("@radix-ui/");
      expect(src).not.toContain("asChild");
    }

    const docSrc = fs.readFileSync(
      path.join(root, "apps/web/src/core/preview/PreviewThemeDocument.astro"),
      "utf8",
    );
    expect(docSrc).toContain('import Layout from "../../themes/default/Layout.astro"');
    expect(docSrc).toContain("showConsent={false}");
    expect(docSrc).toContain("vendorScripts={[]}");
  });
});
