import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDirectoryListingCopyText,
  buildNoindexWarning,
  buildSlugChangeWarning,
  DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  evaluateSeoChecklist,
  extractChecklistSignalsFromRichTextDoc,
  getAllowedSchemaTypeOptions,
  mergeSearchAppearanceSettings,
  RecordExternalVerificationSchema,
  renderEscapedSearchAppearanceTemplate,
  renderSearchAppearanceTemplate,
  renderVerificationMetaTags,
  resolveEffectiveSeoPreview,
  resolveProviderVerificationStatus,
  resolvePublishSafeSchemaType,
  SEARCH_APPEARANCE_KINDS,
  SEARCH_APPEARANCE_SEPARATORS,
  SEARCH_APPEARANCE_TOKENS,
  SeoEditorOverrideInputSchema,
  SeoEditorSettingsPatchSchema,
  validateSchemaTypeForResource,
  validateSearchAppearanceTemplateString,
  validateVerificationToken,
} from "@punyasitus/core/seo/editor";
import { TENANT_0013_SEO_EDITOR_SETTINGS_SQL } from "@punyasitus/db/seo/migrations";
import {
  SEO_AI_AUTOPILOT_MANIFEST,
  SEO_AI_AUTOPILOT_PLUGIN,
  SEO_AI_AUTOPILOT_PLUGIN_ID,
} from "../../packages/plugins/seo-ai-autopilot/index.ts";

const root = path.resolve(import.meta.dirname, "../..");

describe("TASK-052: Search appearance templates & fixed 7-token grammar (PLAN §15.7)", () => {
  it("supports all 9 kinds, fixed 7 tokens, fixed separator set, and default '{{title}} {{sep}} {{site_name}}'", () => {
    expect(SEARCH_APPEARANCE_TOKENS).toEqual([
      "title",
      "site_name",
      "tagline",
      "sep",
      "category",
      "excerpt",
      "page",
    ]);
    expect(SEARCH_APPEARANCE_KINDS).toHaveLength(9);
    expect(SEARCH_APPEARANCE_SEPARATORS.length).toBeGreaterThanOrEqual(7);
    expect(DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates.page.titleTemplate).toBe(
      "{{title}} {{sep}} {{site_name}}",
    );
    expect(DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates.post.titleTemplate).toBe(
      "{{title}} {{sep}} {{site_name}}",
    );
  });

  it("renders tokens, collapses empty optional separators, and escapes HTML text/attribute contexts", () => {
    const rendered = renderSearchAppearanceTemplate(
      "{{title}} {{sep}} {{category}} {{sep}} {{site_name}} {{sep}} {{page}}",
      {
        title: 'Renovasi & Desain "Kantor"',
        site_name: "PT Nusantara <Arsitek>",
        sep: "|",
        category: "",
        page: 2,
      },
    );
    expect(rendered).toBe('Renovasi & Desain "Kantor" | PT Nusantara <Arsitek> | Halaman 2');

    const escapedText = renderEscapedSearchAppearanceTemplate(
      "{{title}} {{sep}} {{site_name}}",
      {
        title: "A & B <script>",
        site_name: "C > D",
        sep: "|",
      },
      "html_text",
    );
    expect(escapedText).not.toContain("<script>");
    expect(escapedText).toContain("&lt;script&gt;");
    expect(escapedText).toContain("&amp;");

    const escapedAttr = renderEscapedSearchAppearanceTemplate(
      "{{title}}",
      { title: 'Quote "here" & <tag>' },
      "html_attr",
    );
    expect(escapedAttr).toContain("&quot;");
    expect(escapedAttr).not.toContain("<tag>");
  });

  it("rejects unknown tokens, malformed braces, and HTML/script injection in templates", () => {
    const badTemplates = [
      "{{title}} {{sep}} {{unknown_token}}",
      "{{title}} {{env}}",
      "{{title }} {{sep}} {{site_name}}",
      "{{title {{sep}} {{site_name}}",
      "Judul }} {{site_name}}",
      "<script>alert(1)</script> {{title}}",
      '<meta name="robots" content="index"> {{title}}',
      "javascript:alert(1) {{title}}",
      "Judul\u0000Null",
    ];
    for (const tpl of badTemplates) {
      const check = validateSearchAppearanceTemplateString(tpl);
      expect(check.ok, `Expected "${tpl}" to fail validation`).toBe(false);
    }

    const parsed = SeoEditorSettingsPatchSchema.safeParse({
      separator: "|",
      templates: {
        page: {
          titleTemplate: "{{title}} {{sep}} {{forbidden}}",
          descriptionTemplate: "{{excerpt}}",
        },
      },
      version: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects arbitrary separator or unknown keys via strict Zod v4 schema", () => {
    expect(
      SeoEditorSettingsPatchSchema.safeParse({
        separator: "<script>",
        version: 1,
      }).success,
    ).toBe(false);

    expect(
      SeoEditorSettingsPatchSchema.safeParse({
        separator: "|",
        robotsTxt: "User-agent: *\nAllow: /",
        version: 1,
      }).success,
    ).toBe(false);
  });
});

describe("TASK-052: Allowed schema types per content kind & visible-fact guards (PLAN §15.4 & §15.7)", () => {
  it("enforces page allowed schema types and requires visible FAQ block for FAQPage", () => {
    expect(validateSchemaTypeForResource("AboutPage", { resourceKind: "page" }).ok).toBe(true);
    expect(validateSchemaTypeForResource("BlogPosting", { resourceKind: "page" }).ok).toBe(false);

    const faqNoBlock = validateSchemaTypeForResource("FAQPage", {
      resourceKind: "page",
      hasVisibleFaqBlock: false,
    });
    expect(faqNoBlock.ok).toBe(false);
    if (!faqNoBlock.ok) {
      expect(faqNoBlock.code).toBe("FAQ_BLOCK_REQUIRED");
    }

    expect(
      validateSchemaTypeForResource("FAQPage", {
        resourceKind: "page",
        hasVisibleFaqBlock: true,
      }).ok,
    ).toBe(true);
  });

  it("enforces post allowed schema types (BlogPosting, Article, NewsArticle)", () => {
    expect(validateSchemaTypeForResource("BlogPosting", { resourceKind: "post" }).ok).toBe(true);
    expect(validateSchemaTypeForResource("Article", { resourceKind: "post" }).ok).toBe(true);
    expect(validateSchemaTypeForResource("NewsArticle", { resourceKind: "post" }).ok).toBe(true);
    expect(validateSchemaTypeForResource("Product", { resourceKind: "post" }).ok).toBe(false);
    expect(validateSchemaTypeForResource("FAQPage", { resourceKind: "post" }).ok).toBe(false);
  });

  it("enforces offering schema guards: Product requires visible fixed/from price; TouristTrip requires itinerary", () => {
    // Product with on_request -> rejected
    const prodInquiry = validateSchemaTypeForResource("Product", {
      resourceKind: "offering",
      offeringType: "product",
      priceMode: "on_request",
      price: null,
    });
    expect(prodInquiry.ok).toBe(false);
    if (!prodInquiry.ok) {
      expect(prodInquiry.code).toBe("PRODUCT_SCHEMA_REQUIRES_PRICE");
    }

    // Product with fixed price -> allowed
    expect(
      validateSchemaTypeForResource("Product", {
        resourceKind: "offering",
        offeringType: "product",
        priceMode: "fixed",
        price: 250_000,
      }).ok,
    ).toBe(true);

    // Service cannot be Product
    expect(
      validateSchemaTypeForResource("Product", {
        resourceKind: "offering",
        offeringType: "service",
        priceMode: "fixed",
        price: 250_000,
      }).ok,
    ).toBe(false);

    // Tour without visible itinerary -> rejected
    const tourNoItinerary = validateSchemaTypeForResource("TouristTrip", {
      resourceKind: "offering",
      offeringType: "tour",
      hasVisibleItinerary: false,
    });
    expect(tourNoItinerary.ok).toBe(false);
    if (!tourNoItinerary.ok) {
      expect(tourNoItinerary.code).toBe("TOURIST_TRIP_REQUIRES_ITINERARY");
    }

    expect(
      validateSchemaTypeForResource("TouristTrip", {
        resourceKind: "offering",
        offeringType: "tour",
        hasVisibleItinerary: true,
      }).ok,
    ).toBe(true);

    // Taxonomy options empty
    expect(getAllowedSchemaTypeOptions({ resourceKind: "taxonomy" })).toEqual([]);
  });

  it("rejects arbitrary canonical, script, HTML, or custom schema JSON in per-resource override schema", () => {
    expect(
      SeoEditorOverrideInputSchema.safeParse({
        canonicalOverride: "https://evil.example/hijack",
      }).success,
    ).toBe(false);

    expect(
      SeoEditorOverrideInputSchema.safeParse({
        customSchemaJson: '{"@type":"Product"}',
      }).success,
    ).toBe(false);

    expect(
      SeoEditorOverrideInputSchema.safeParse({
        titleOverride: "<script>alert(1)</script>",
      }).success,
    ).toBe(false);

    expect(
      SeoEditorOverrideInputSchema.safeParse({
        titleOverride: "Judul Valid {{sep}} {{site_name}}",
        descriptionOverride: "Deskripsi valid untuk pengunjung.",
        focusKeyphrase: "jasa renovasi kantor",
        ogTitleOverride: "Judul OG Valid",
        ogDescriptionOverride: "Deskripsi OG Valid",
        ogImageMediaId: 12,
        schemaType: "AboutPage",
        noindex: true,
        nofollow: true,
      }).success,
    ).toBe(true);
  });
});

describe("TASK-052: Verification tokens & configured-vs-externally-verified state (REQ-055, PLAN §15.5)", () => {
  it("accepts safe plain verification tokens and rejects HTML/meta/script/quote/space injection", () => {
    expect(validateVerificationToken("google", "abcDEF123456_.-XYZ").ok).toBe(true);
    expect(validateVerificationToken("bing", "0123456789ABCDEF123456").ok).toBe(true);
    expect(validateVerificationToken("yandex", "a1b2c3d4e5f6").ok).toBe(true);

    const maliciousTokens = [
      '<meta name="google-site-verification" content="abc1234567890" />',
      'abc1234567890" onload="alert(1)',
      "abc1234567890'><script>alert(1)</script>",
      "token with spaces 1234567890",
      "token\nnewline12345",
      "short",
    ];
    for (const bad of maliciousTokens) {
      expect(validateVerificationToken("google", bad).ok, `google must reject ${bad}`).toBe(false);
      expect(validateVerificationToken("bing", bad).ok, `bing must reject ${bad}`).toBe(false);
      expect(validateVerificationToken("yandex", bad).ok, `yandex must reject ${bad}`).toBe(false);
    }

    const tags = renderVerificationMetaTags({
      google: "validGoogleToken_12345",
      bing: "0123456789ABCDEF1234",
      yandex: "yandex123456",
    });
    expect(tags).toEqual([
      '<meta name="google-site-verification" content="validGoogleToken_12345" />',
      '<meta name="msvalidate.01" content="0123456789ABCDEF1234" />',
      '<meta name="yandex-verification" content="yandex123456" />',
    ]);
  });

  it("distinguishes configured vs externally_verified and invalidates on primary-domain switch", () => {
    // 1. Saved locally (not yet externally verified) -> configured, NEVER externally_verified
    const configured = resolveProviderVerificationStatus({
      provider: "google",
      draftToken: "validGoogleToken_12345",
      publishedToken: "validGoogleToken_12345",
      externalVerification: null,
      currentPrimaryHost: "www.toko-alpha.id",
    });
    expect(configured.status).toBe("configured");
    expect(configured.statusLabel).toContain("Terkonfigurasi");
    expect(configured.domainChangedSinceVerification).toBe(false);

    // 2. Human records external verification on www.toko-alpha.id -> externally_verified
    const verified = resolveProviderVerificationStatus({
      provider: "google",
      draftToken: "validGoogleToken_12345",
      publishedToken: "validGoogleToken_12345",
      externalVerification: {
        verifiedHost: "www.toko-alpha.id",
        verifiedAt: "2026-11-23T10:00:00.000Z",
        verifiedByUserId: "user_owner_1",
        note: "Verified in GSC",
      },
      currentPrimaryHost: "www.toko-alpha.id",
    });
    expect(verified.status).toBe("externally_verified");
    expect(verified.domainChangedSinceVerification).toBe(false);

    // 3. Tenant switches primary domain to www.toko-baru.id -> automatically recheck_required!
    const invalidated = resolveProviderVerificationStatus({
      provider: "google",
      draftToken: "validGoogleToken_12345",
      publishedToken: "validGoogleToken_12345",
      externalVerification: {
        verifiedHost: "www.toko-alpha.id",
        verifiedAt: "2026-11-23T10:00:00.000Z",
        verifiedByUserId: "user_owner_1",
        note: "Verified in GSC",
      },
      currentPrimaryHost: "www.toko-baru.id",
    });
    expect(invalidated.status).toBe("recheck_required");
    expect(invalidated.domainChangedSinceVerification).toBe(true);
    expect(invalidated.helperText).toContain("www.toko-alpha.id");
    expect(invalidated.helperText).toContain("www.toko-baru.id");

    // RecordExternalVerificationSchema rejects unknown keys
    expect(
      RecordExternalVerificationSchema.safeParse({
        provider: "google",
        verifiedHost: "www.toko-alpha.id",
        extra: true,
        version: 2,
      }).success,
    ).toBe(false);
  });
});

describe("TASK-052: Effective preview, noindex inheritance & non-blocking advisory checklist", () => {
  it("enforces site-wide noindex dominance and trial noindex over per-page settings", () => {
    const siteNoindex = resolveEffectiveSeoPreview({
      tenant: {
        tenantHandle: "alpha",
        tenantStatus: "active",
        primaryHost: "www.alpha.id",
        primaryHostKind: "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        verifiedTenantHosts: ["www.alpha.id"],
        servingHost: "www.alpha.id",
      },
      siteName: "Alpha Arsitek",
      siteVisibility: "noindex",
      resourceKind: "page",
      searchAppearanceKind: "page",
      routeKind: "page",
      pathname: "/tentang-kami",
      resourceTitle: "Tentang Kami",
      publicationState: "published",
      seo: { noindex: false, nofollow: false },
    });
    expect(siteNoindex.effectiveIndexable).toBe(false);
    expect(siteNoindex.siteWideNoindexDominates).toBe(true);
    expect(siteNoindex.robotsMeta).toBe("noindex, follow");
    expect(siteNoindex.indexabilityReasons.some((r) => r.code === "site_wide_noindex")).toBe(true);

    const nofollowPublished = resolveEffectiveSeoPreview({
      tenant: {
        tenantHandle: "alpha",
        tenantStatus: "active",
        primaryHost: "www.alpha.id",
        primaryHostKind: "custom",
        primaryHostStatus: "active",
        primaryHostSslStatus: "active",
        primaryHostVerified: true,
        verifiedTenantHosts: ["www.alpha.id"],
        servingHost: "www.alpha.id",
      },
      siteName: "Alpha Arsitek",
      siteVisibility: "public",
      resourceKind: "post",
      searchAppearanceKind: "post",
      routeKind: "post",
      pathname: "/blog/tips-renovasi",
      resourceTitle: "Tips Renovasi Kantor",
      publicationState: "published",
      seo: { noindex: false, nofollow: true },
    });
    expect(nofollowPublished.effectiveIndexable).toBe(true);
    expect(nofollowPublished.robotsMeta).toContain("index, nofollow");
    expect(nofollowPublished.canonicalUrl).toBe("https://www.alpha.id/blog/tips-renovasi");
    expect(nofollowPublished.twitterCard).toBe("summary_large_image");
  });

  it("evaluates focus keyphrase, cannibalization, duplicates, ALT, and headings without any numeric score or publish block", () => {
    const signals = extractChecklistSignalsFromRichTextDoc(
      {
        schemaVersion: 1,
        blocks: [
          {
            type: "paragraph",
            text: "Layanan jasa renovasi kantor di Jakarta membantu bisnis menata ruang kerja modern.",
          },
          { type: "heading", level: 2, text: "Keunggulan Jasa Renovasi Kantor Kami" },
          {
            type: "paragraph",
            text: "Lihat daftar layanan kami lainnya.",
            href: "/layanan/desain-interior",
          },
          { type: "image", mediaId: 1, text: "Tim renovasi menata ruang rapat kantor" },
        ],
      },
      "www.alpha.id",
    );

    const checklist = evaluateSeoChecklist({
      resourceKind: "post",
      effectiveTitle: "Panduan Jasa Renovasi Kantor Modern | Alpha Arsitek",
      effectiveDescription:
        "Pelajari panduan lengkap jasa renovasi kantor modern di Jakarta mulai dari estimasi biaya, jadwal pengerjaan, hingga pemilihan material berkualitas.",
      isFallbackDescription: false,
      slug: "jasa-renovasi-kantor-modern",
      focusKeyphrase: "jasa renovasi kantor",
      firstParagraphText: signals.firstParagraphText,
      headings: signals.headings,
      plainTextBody: signals.plainTextBody,
      internalLinkCount: signals.internalLinkCount,
      images: signals.images,
      publishedPeers: [
        {
          resourceKind: "page",
          resourceId: 9,
          title: "Layanan Renovasi",
          effectiveTitle: "Layanan Renovasi | Alpha Arsitek",
          effectiveDescription: "Deskripsi lain",
          focusKeyphrase: "jasa renovasi kantor",
          pathname: "/layanan-renovasi",
        },
      ],
      slugChangedWhilePublished: true,
      oldPublishedSlug: "renovasi-lama",
      noindex: true,
    });

    expect(checklist.blocking).toBe(false);
    expect(checklist.summaryLabel).toMatch(/^\d+ dari \d+ saran terpenuhi$/);
    expect(checklist.items.every((item) => item.blocking === false)).toBe(true);
    expect(checklist.items.find((i) => i.id === "keyphrase_in_title")?.status).toBe("pass");
    expect(checklist.items.find((i) => i.id === "keyphrase_in_slug")?.status).toBe("pass");
    expect(checklist.items.find((i) => i.id === "keyphrase_in_first_paragraph")?.status).toBe("pass");
    expect(checklist.items.find((i) => i.id === "keyphrase_in_h2")?.status).toBe("pass");
    expect(checklist.items.find((i) => i.id === "keyphrase_cannibalization")?.status).toBe(
      "advisory",
    );
    expect(checklist.slugChangeNotice?.message).toContain("308");
    expect(checklist.noindexNotice?.message).toContain("bukan privasi");

    // Helpers
    expect(buildSlugChangeWarning("lama", "baru").message).toContain("tidak disertai jaminan peringkat");
    expect(buildNoindexWarning().message).toContain("memerlukan waktu");
  });

  it("formats factual GBP & Bing Places copy text without fabricating missing address/hours", () => {
    const text = buildDirectoryListingCopyText({
      businessName: "PT Nusantara Arsitek",
      businessCategory: "HomeAndConstructionBusiness",
      primaryOrigin: "https://www.nusantara.id",
      city: "Jakarta Selatan",
      whatsappE164: "6281234567890",
    });
    expect(text).toContain("Nama Bisnis: PT Nusantara Arsitek");
    expect(text).toContain("Situs Web: https://www.nusantara.id");
    expect(text).toContain("WhatsApp: +6281234567890");
    expect(text).not.toContain("Jam Operasional:");
  });
});

describe("TASK-052: Plugin manifest, migration byte-parity & base-nova UI hygiene", () => {
  it("validates seo-ai-autopilot manifest, tablePrefix isolation, and zero public JS budget", () => {
    expect(SEO_AI_AUTOPILOT_PLUGIN_ID).toBe("seo-ai-autopilot");
    expect(SEO_AI_AUTOPILOT_MANIFEST.visibility).toBe("public_free");
    expect(SEO_AI_AUTOPILOT_MANIFEST.priceIdr).toBe(0);
    expect(SEO_AI_AUTOPILOT_MANIFEST.tablePrefix).toBe("plg_seo_ai_autopilot__");
    expect(SEO_AI_AUTOPILOT_MANIFEST.maxPublicJsBytes).toBe(0);
    expect(SEO_AI_AUTOPILOT_PLUGIN.migrations?.length).toBe(1);
  });

  it("matches bundled migration 0013 SQL byte-for-byte and uses canonical plg_seo_ai_autopilot__settings table", () => {
    const diskSql = fs.readFileSync(
      path.join(root, "packages/db/migrations/tenant/0013_seo_editor_settings.sql"),
      "utf8",
    );
    expect(TENANT_0013_SEO_EDITOR_SETTINGS_SQL).toBe(diskSql);
    expect(diskSql).toContain("CREATE TABLE IF NOT EXISTS plg_seo_ai_autopilot__settings");
    expect(diskSql).not.toContain("CREATE TABLE IF NOT EXISTS seo_editor_settings");
  });

  it("downgrades schemaType safely via resolvePublishSafeSchemaType when visible facts are removed", () => {
    const faqDowngraded = resolvePublishSafeSchemaType("FAQPage", {
      resourceKind: "page",
      hasVisibleFaqBlock: false,
    });
    expect(faqDowngraded.downgraded).toBe(true);
    expect(faqDowngraded.schemaType).toBe("WebPage");

    const prodDowngraded = resolvePublishSafeSchemaType("Product", {
      resourceKind: "offering",
      offeringType: "product",
      priceMode: "on_request",
      price: null,
    });
    expect(prodDowngraded.downgraded).toBe(true);
    expect(prodDowngraded.schemaType).toBe("Service");

    const tourDowngraded = resolvePublishSafeSchemaType("TouristTrip", {
      resourceKind: "offering",
      offeringType: "tour",
      hasVisibleItinerary: false,
    });
    expect(tourDowngraded.downgraded).toBe(true);
    expect(tourDowngraded.schemaType).toBe("Service");
  });

  it("rejects Unicode bidi / zero-width control chars and hardens mergeSearchAppearanceSettings against malformed entries", () => {
    expect(validateSearchAppearanceTemplateString("Judul\u202EReverse").ok).toBe(false);
    expect(validateSearchAppearanceTemplateString("Judul\u200BZeroWidth").ok).toBe(false);
    expect(validateSearchAppearanceTemplateString("Judul\uFEFFBom").ok).toBe(false);

    const merged = mergeSearchAppearanceSettings(DEFAULT_SEARCH_APPEARANCE_SETTINGS, {
      separator: "invalid" as unknown as "|",
      templates: {
        page: { titleTemplate: undefined as unknown as string, descriptionTemplate: "" },
      },
    });
    expect(merged.separator).toBe("|");
    expect(merged.templates.page.titleTemplate).toBe("{{title}} {{sep}} {{site_name}}");
    expect(merged.templates.page.descriptionTemplate).toBe("{{excerpt}}");
  });

  it("contains zero @radix-ui imports, zero asChild, and zero banned Sparkles icons (DEC-036)", () => {
    const uiFiles = [
      "apps/web/src/components/admin/seo/SeoOverrideDrawer.tsx",
      "apps/web/src/components/admin/seo/SeoAutopilotSettingsClient.tsx",
    ];
    for (const rel of uiFiles) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      expect(src, `${rel} must not import @radix-ui`).not.toContain("@radix-ui");
      expect(src, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
      expect(src, `${rel} must not use banned Sparkles icon`).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});
