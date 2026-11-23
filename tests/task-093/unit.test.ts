import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyVerticalBlueprint,
  B2B_BLUEPRINT_CATALOG,
  B2B_BLUEPRINT_IDS,
  buildBlueprintProfilePageSchema,
  buildDualLocalListingsCopyCard,
  completeGuidedChecklistStep,
  createInitialGuidedChecklistState,
  detectSampleClaimsInSection,
  dismissAllGuidedChecklist,
  dismissGuidedChecklistStep,
  evaluateGuidedOnboardingChecklist,
  filterActiveTourDepartures,
  filterExpiredTourDeparturesAtRender,
  filterExpiredTourDeparturesInSectionsAtRender,
  getAdaptiveSidebarOfferingForBlueprint,
  GUIDED_ONBOARDING_STEP_IDS,
  GuidedOnboardingChecklistStateSchema,
  isValidIsoCalendarDate,
  mergeBlueprintNonDestructively,
  MinimalOnboardingInputSchema,
  parseGuidedChecklistState,
  resetGuidedChecklistStep,
  restoreGuidedChecklist,
  SafeCanonicalOriginSchema,
  serializeGuidedChecklistState,
} from "@punyasitus/core/presets/index";
import { generateSchemaGraph } from "@punyasitus/core/schema-generator";
import {
  CLOSED_SECTION_TYPES,
  computeContrastRatio,
  PERMENKES_TESTIMONIALS_WARNING_CODE,
  PLATFORM_THEME_IDS,
  switchPageThemeLosslessly,
} from "@punyasitus/core/theme/index";
import { auditCustomThemeSourceFiles } from "../../apps/web/src/core/theme-registry.ts";
import { CATALOG_THEME_MANIFEST } from "../../apps/web/src/themes/catalog/theme.ts";
import { COMPRO_THEME_MANIFEST } from "../../apps/web/src/themes/compro/theme.ts";
import { DEALER_THEME_MANIFEST } from "../../apps/web/src/themes/dealer/theme.ts";
import { RESTO_THEME_MANIFEST } from "../../apps/web/src/themes/resto/theme.ts";
import { SALES_THEME_MANIFEST } from "../../apps/web/src/themes/sales/theme.ts";
import { TRAVEL_THEME_MANIFEST } from "../../apps/web/src/themes/travel/theme.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const ALL_PLATFORM_MANIFESTS = [
  COMPRO_THEME_MANIFEST,
  SALES_THEME_MANIFEST,
  TRAVEL_THEME_MANIFEST,
  CATALOG_THEME_MANIFEST,
  RESTO_THEME_MANIFEST,
  DEALER_THEME_MANIFEST,
] as const;

function walkFiles(dir: string, exts: Set<string>, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (exts.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

describe("TASK-093 Unit: 7 Zero-Guesswork B2B Vertical Conversion Blueprints", () => {
  it("exposes all 7 canonical B2B vertical blueprints with exact metadata, claim-free defaults, and 3 draft E-E-A-T blog outlines", () => {
    expect(B2B_BLUEPRINT_IDS).toEqual([
      "b2b_corporate",
      "sales_executive",
      "personal_brand",
      "regulated_professional",
      "travel_umrah_agency",
      "offline_multibranch",
      "wa_catalog_showcase",
    ]);
    expect(B2B_BLUEPRINT_CATALOG).toHaveLength(7);

    for (const bpId of B2B_BLUEPRINT_IDS) {
      const applied = applyVerticalBlueprint({
        businessName: `Usaha ${bpId}`,
        blueprintId: bpId,
        whatsappPhone: "0812-3456-7890",
        city: "Jakarta Selatan",
        handle: "demo-usaha",
      });

      // Exact section sequence matches blueprint contract
      expect(applied.sections.map((s) => s.type)).toEqual([...applied.blueprint.sectionSequence]);
      // Zero Lorem Ipsum anywhere
      expect(JSON.stringify(applied.sections).toLowerCase()).not.toContain("lorem ipsum");
      // Claim-free default meta: never fabricates "Dealer Resmi" or "B2B Resmi" when omitted
      expect(applied.metaTitle).not.toContain("Dealer Resmi");
      expect(applied.metaTitle).not.toContain("B2B Resmi");
      expect(applied.metaDescription).not.toContain("Dealer Resmi");

      // Sample marker present on starter copy
      expect(applied.sampleSectionIds.length).toBeGreaterThanOrEqual(2);
      // Zero fabricated reviews, trust logos, gallery photos, or offerings
      for (const sec of applied.sections) {
        if (sec.type === "testimonials") {
          expect(sec.config.items).toEqual([]);
          expect(sec.enabled).toBe(false);
        }
        if (sec.type === "trust_logos") {
          expect(sec.config.items).toEqual([]);
        }
        if (sec.type === "gallery") {
          expect(sec.config.items).toEqual([]);
        }
        if (
          sec.type === "services_grid" ||
          sec.type === "products_grid" ||
          sec.type === "tours_grid" ||
          sec.type === "vehicles_grid"
        ) {
          expect(sec.config.items).toEqual([]);
        }
      }

      // Vertical Title/Meta templates rendered cleanly
      expect(applied.metaTitle.length).toBeGreaterThan(10);
      expect(applied.metaDescription.length).toBeGreaterThan(25);
      // Semantic HTML <table> & <dl> AI Fact-Sheet blocks emitted
      expect(applied.aiFactSheetHtml).toContain("<table>");
      expect(applied.aiFactSheetDefinitionListHtml).toContain("<dl>");
      // 3 draft E-E-A-T blog outlines marked CONTOH and never auto-published
      expect(applied.draftBlogOutlines).toHaveLength(3);
      for (const post of applied.draftBlogOutlines) {
        expect(post.status).toBe("draft");
        expect(post.autoPublish).toBe(false);
        expect(post.sampleBadge).toBe("CONTOH");
        expect(post.title).toContain("CONTOH");
      }
      // Dual Google Business Profile + Bing Places copy card with zero fabricated defaults or external API calls
      expect(applied.localListingsCard.platforms).toEqual([
        "Google Business Profile",
        "Bing Places",
      ]);
      expect(applied.localListingsCard.callsExternalApi).toBe(false);
      expect(applied.localListingsCard.copyPlainText).toContain(`Usaha ${bpId}`);
      expect(applied.localListingsCard.copyPlainText).toContain("https://demo-usaha.situsku.click/");
      // Unfilled address/hours must NOT fabricate fake schedule or street address in copyPlainText
      expect(applied.localListingsCard.copyPlainText).not.toContain("09.00–17.00");
      expect(applied.localListingsCard.copyPlainText).not.toContain("Jakarta Selatan, Indonesia");

      // Adaptive sidebar offering config exposes 1 primary type and hides the other 3
      expect(applied.sidebarOffering.hiddenOfferingTypes).toHaveLength(3);
      expect(applied.sidebarOffering.hiddenOfferingTypes).not.toContain(
        applied.sidebarOffering.primaryOfferingType,
      );

      // Valid normalized wa.me URL & starter form template
      expect(applied.whatsappUrl).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
      expect(applied.starterFormTemplate.fields.length).toBeGreaterThanOrEqual(5);
      expect(applied.credentialPrompts.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("supports medical_clinic, legal_notary, and tax_accounting subtypes on regulated_professional with testimonials OFF and ZERO AggregateRating", () => {
    const medical = applyVerticalBlueprint({
      businessName: "Klinik Gigi Harmoni",
      blueprintId: "regulated_professional",
      regulatedSubtype: "medical_clinic",
      whatsappPhone: "081299988877",
      city: "Bandung",
    });

    expect(medical.resolvedSchemaPrimaryType).toBe("MedicalClinic");
    expect(medical.resolvedBusinessCategory).toBe("medical_clinic");
    expect(medical.credentialPrompts.some((c) => c.key === "sipStr")).toBe(true);
    expect(medical.warnings.some((w) => w.code === PERMENKES_TESTIMONIALS_WARNING_CODE)).toBe(true);

    const legal = applyVerticalBlueprint({
      businessName: "Kantor Notaris & PPAT Pratama",
      blueprintId: "regulated_professional",
      regulatedSubtype: "legal_notary",
      whatsappPhone: "081299988877",
      city: "Jakarta",
    });
    expect(legal.resolvedSchemaPrimaryType).toBe("LegalService");
    expect(legal.resolvedBusinessCategory).toBe("legal_service");
    expect(legal.credentialPrompts.some((c) => c.key === "barNotaryJurisdiction")).toBe(true);

    const tax = applyVerticalBlueprint({
      businessName: "KAP & Konsultan Pajak Nusantara",
      blueprintId: "regulated_professional",
      regulatedSubtype: "tax_accounting",
      whatsappPhone: "081299988877",
      city: "Surabaya",
    });
    expect(tax.resolvedSchemaPrimaryType).toBe("AccountingService");
    expect(tax.resolvedBusinessCategory).toBe("accounting_service");

    for (const regulated of [medical, legal, tax]) {
      const testimonials = regulated.sections.find((s) => s.type === "testimonials");
      expect(testimonials?.enabled).toBe(false);
      expect(regulated.aggregateRatingDisabled).toBe(true);
      expect(regulated.resolvedSchemaPrimaryType).not.toBe("ProfessionalService");
      expect(JSON.stringify(regulated.sections)).not.toContain("AggregateRating");
      expect(JSON.stringify(regulated.sections)).not.toContain("ProfessionalService");
      expect(regulated.aiFactSheetHtml).not.toContain("AggregateRating");
      const schemaRes = generateSchemaGraph({
        seo: {
          surface: "public_tenant",
          routeKind: "homepage",
          pathname: "/",
          tenant: {
            tenantHandle: "demo-regulated",
            tenantStatus: "active",
          },
          resourceState: "published",
        },
        tenantId: "01JT093REGULATED000000001",
        siteName: regulated.input.businessName,
        business: {
          businessName: regulated.input.businessName,
          businessCategory: regulated.resolvedBusinessCategory,
        },
      });
      expect(schemaRes.emitted).toBe(true);
      expect(schemaRes.jsonLd ?? "").not.toContain("AggregateRating");
      expect(schemaRes.jsonLd ?? "").not.toContain("ProfessionalService");
      expect(schemaRes.jsonLd ?? "").toContain(regulated.resolvedSchemaPrimaryType);
      const customFormSec = regulated.sections.find((s) => s.type === "custom_form");
      expect(customFormSec?.type === "custom_form" && customFormSec.config.note).toContain("UU PDP");
    }
  });

  it("emits Google ProfilePage (Person) JSON-LD linked via @id to BlogPosting.author and omits AutoDealer when affiliation is unprovided", () => {
    const personal = applyVerticalBlueprint({
      businessName: "Dr. Hendi Pratama",
      blueprintId: "personal_brand",
      whatsappPhone: "081122334455",
      city: "Semarang",
      canonicalOrigin: "https://hendipratama.id",
    });

    expect(personal.autoEnableFreePlugins).toContain("bio-links");
    expect(personal.sidebarOffering.primaryMenuLabel).toBe("Topik & Layanan");
    const pGraph = personal.profilePageSchema?.["@graph"] ?? [];
    const pProfile = pGraph.find((n) => n["@type"] === "ProfilePage");
    const pPerson = pGraph.find((n) => n["@type"] === "Person");
    const pPost = pGraph.find((n) => n["@type"] === "BlogPosting");
    expect(pProfile?.mainEntity).toEqual({ "@id": "https://hendipratama.id/#person" });
    expect(pPerson?.["@id"]).toBe("https://hendipratama.id/#person");
    expect(pPost?.author).toEqual({ "@id": "https://hendipratama.id/#person" });

    // Sales executive WITH explicit affiliation
    const salesWithDealer = applyVerticalBlueprint({
      businessName: "Sugi Andrian",
      blueprintId: "sales_executive",
      whatsappPhone: "081344556677",
      city: "Jakarta Utara",
      affiliatedDealerName: "Dealer Chery Arta PIK",
      canonicalOrigin: "https://sugi-auto.situsku.click",
    });
    const sGraph = salesWithDealer.profilePageSchema?.["@graph"] ?? [];
    expect(sGraph.find((n) => n["@type"] === "AutoDealer")?.name).toBe("Dealer Chery Arta PIK");
    expect(salesWithDealer.metaTitle).toContain("(Dealer Chery Arta PIK)");

    // Sales executive WITHOUT affiliation: NEVER fabricates AutoDealer or "(Dealer Resmi)"
    const salesNoDealer = applyVerticalBlueprint({
      businessName: "Galang Saputra",
      blueprintId: "sales_executive",
      whatsappPhone: "081344556677",
      city: "Batam",
      canonicalOrigin: "https://galang-auto.situsku.click",
    });
    const noDealerGraph = salesNoDealer.profilePageSchema?.["@graph"] ?? [];
    expect(noDealerGraph.find((n) => n["@type"] === "AutoDealer")).toBeUndefined();
    expect(salesNoDealer.metaTitle).not.toContain("Dealer Resmi");
    expect(
      salesNoDealer.aiFactSheetItems.find((i) => i.label === "Layanan Pembelian")?.isSample,
    ).toBe(true);

    expect(
      buildBlueprintProfilePageSchema({
        blueprintId: "b2b_corporate",
        personName: "PT Kemas",
        canonicalOrigin: "https://kemas.situsku.click",
      }),
    ).toBeNull();
  });

  it("enforces strict HTTPS canonicalOrigin, valid Gregorian departureDate, rejects client nowIso, and filters expired departures at render time", () => {
    // Hostile canonicalOrigin schemes/formats MUST fail
    const hostileOrigins = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com",
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com/nested/path",
      "https://example.com/?q=1",
      "https://localhost",
    ];
    for (const bad of hostileOrigins) {
      expect(SafeCanonicalOriginSchema.safeParse(bad).success, `Should reject ${bad}`).toBe(false);
    }
    expect(SafeCanonicalOriginSchema.parse("https://toko.situsku.click/")).toBe(
      "https://toko.situsku.click",
    );

    // Invalid calendar dates MUST fail
    expect(isValidIsoCalendarDate("2026-99-99")).toBe(false);
    expect(isValidIsoCalendarDate("2026-02-30")).toBe(false);
    expect(isValidIsoCalendarDate("2025-02-29")).toBe(false);
    expect(isValidIsoCalendarDate("2024-02-29")).toBe(true);
    expect(isValidIsoCalendarDate("2026-12-18")).toBe(true);

    // Public payload MUST reject `nowIso` (server clock is second arg only!)
    expect(
      MinimalOnboardingInputSchema.safeParse({
        businessName: "Al-Mizan Tour",
        blueprintId: "travel_umrah_agency",
        whatsappPhone: "081566778899",
        nowIso: "2020-01-01T00:00:00Z",
      }).success,
    ).toBe(false);

    const departures = [
      {
        packageName: "Umrah Syawal (Expired)",
        departureDate: "2025-04-10",
        durationLabel: "9 Hari 7 Malam",
        airline: "Saudia",
        hotelSummary: "Hotel Madinah & Makkah",
        priceIdrLabel: "Rp 31.500.000",
      },
      {
        packageName: "Umrah Reguler Desember",
        departureDate: "2026-12-18",
        durationLabel: "9 Hari 7 Malam",
        airline: "Garuda Indonesia",
        hotelSummary: "Anwar Al Madinah / Swissotel",
        priceIdrLabel: "Rp 33.900.000",
      },
    ];

    // Apply at an earlier date when both are active, then filter at a later render-time `now`
    const seededEarly = applyVerticalBlueprint(
      {
        businessName: "Al-Mizan Tour & Umrah",
        blueprintId: "travel_umrah_agency",
        whatsappPhone: "081566778899",
        city: "Surabaya",
        credentials: { skKemenagPpiu: "U.245 Tahun 2024" },
        tourDepartures: departures,
      },
      { now: "2025-01-15T00:00:00Z" },
    );
    expect(seededEarly.activeTourDepartures).toHaveLength(2);
    expect(seededEarly.aiFactSheetHtml).toContain("Umrah Syawal (Expired)");

    // Render-time filter on later date strips expired departure from both list and saved section HTML!
    const activeLater = filterExpiredTourDeparturesAtRender(departures, "2026-11-23T00:00:00Z");
    expect(activeLater.map((d) => d.packageName)).toEqual(["Umrah Reguler Desember"]);
    expect(filterActiveTourDepartures(departures, "2026-11-23T00:00:00Z")).toEqual(activeLater);

    const filteredSections = filterExpiredTourDeparturesInSectionsAtRender(
      seededEarly.sections,
      "2026-11-23T00:00:00Z",
    );
    const aboutSec = filteredSections.find((s) => s.type === "about");
    const renderedBody = aboutSec?.type === "about" ? aboutSec.config.bodyHtml : "";
    expect(renderedBody).toContain("Umrah Reguler Desember");
    expect(renderedBody).not.toContain("Umrah Syawal (Expired)");
  });

  it("safely escapes hostile XSS payloads in businessName and credentials and disables sample sections during non-destructive merge", () => {
    const xssCorp = applyVerticalBlueprint({
      businessName: 'PT Aman <script>alert("xss")</script>',
      blueprintId: "b2b_corporate",
      whatsappPhone: "081234567890",
      credentials: { isoSniTkdn: 'ISO <img src=x onerror=alert(1)> 9001' },
    });

    expect(xssCorp.aiFactSheetHtml).not.toContain("<script");
    expect(xssCorp.aiFactSheetHtml).not.toContain("<img");
    expect(xssCorp.aiFactSheetHtml).toContain("&lt;img");
    expect(xssCorp.aiFactSheetDefinitionListHtml).not.toContain("<script");
    expect(xssCorp.aiFactSheetDefinitionListHtml).not.toContain("<img");
    expect(xssCorp.aiFactSheetDefinitionListHtml).toContain("&lt;img");

    const xssOffline = applyVerticalBlueprint({
      businessName: 'Warung <script>alert("xss")</script>',
      blueprintId: "offline_multibranch",
      whatsappPhone: "081234567890",
    });
    expect(xssOffline.aiFactSheetHtml).not.toContain("<script");
    expect(xssOffline.aiFactSheetDefinitionListHtml).not.toContain("<script");
    expect(xssOffline.aiFactSheetDefinitionListHtml).toContain("&lt;script&gt;");
    expect(xssOffline.aiFactSheetDefinitionListHtml).toContain("&quot;xss&quot;");

    // Non-destructive merge preserves user-edited hero while forcing unedited [Contoh] sections disabled!
    const first = applyVerticalBlueprint({
      businessName: "PT Kemas Jaya",
      blueprintId: "b2b_corporate",
      whatsappPhone: "081234567890",
    });
    const edited = first.sections.slice(0, 1).map((s) =>
      s.type === "hero"
        ? {
            ...s,
            config: {
              ...s.config,
              eyebrow: "Profil",
              heading: "PT Kemas Jaya — Pabrik Kemasan Bergelombang",
              subheading: "Produksi 6.000 ton/bulan untuk kebutuhan industri Indonesia.",
            },
          }
        : s,
    );

    const nextBp = applyVerticalBlueprint({
      businessName: "PT Kemas Jaya",
      blueprintId: "wa_catalog_showcase",
      whatsappPhone: "081234567890",
    });

    const merged = mergeBlueprintNonDestructively(edited, nextBp);
    const preservedHero = merged.find((s) => s.type === "hero");
    expect(preservedHero?.type === "hero" && preservedHero.config.heading).toBe(
      "PT Kemas Jaya — Pabrik Kemasan Bergelombang",
    );
    expect(preservedHero?.enabled).toBe(true);

    // Every remaining sample section in merged draft MUST be disabled (`enabled: false`)
    for (const sec of merged) {
      if (detectSampleClaimsInSection(sec).length > 0) {
        expect(sec.enabled, `Sample section ${sec.id} must be disabled in merged draft`).toBe(false);
      }
    }
    expect(getAdaptiveSidebarOfferingForBlueprint("offline_multibranch").highlightBranchesMenu).toBe(
      true,
    );
  });
});

describe("TASK-093 Unit: Six Platform Themes, Zero Fabricated Badges & Lossless Cross-Theme Switching", () => {
  it("registers all 6 distinct WCAG-AA-verified platform themes with <= 1 custom font and full closed section support", () => {
    expect(ALL_PLATFORM_MANIFESTS.map((m) => m.id)).toEqual([...PLATFORM_THEME_IDS]);

    const seenPrimaryColors = new Set<string>();
    for (const manifest of ALL_PLATFORM_MANIFESTS) {
      expect(manifest.tier).toBe("included");
      expect(manifest.fontBudget.defaultFont).toBe("system");
      expect(manifest.fontBudget.maxCustomFonts).toBeLessThanOrEqual(1);
      expect(manifest.supportedSectionTypes).toEqual(CLOSED_SECTION_TYPES);
      expect(manifest.supportedRoutes).toHaveLength(7);

      expect(
        computeContrastRatio(manifest.defaultTokens.primaryColor, manifest.palette.surface),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        computeContrastRatio(manifest.defaultTokens.secondaryColor, manifest.palette.surface),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        computeContrastRatio(manifest.palette.ink, manifest.palette.surface),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        computeContrastRatio(manifest.palette.inkMuted, manifest.palette.surface),
      ).toBeGreaterThanOrEqual(4.5);

      seenPrimaryColors.add(manifest.defaultTokens.primaryColor);

      expect(() =>
        manifest.validatePresentationConfig({
          tokens: { primaryColor: "#112233; background: url(https://evil.test/x)" },
        }),
      ).toThrow();
    }

    expect(seenPrimaryColors.size).toBe(6);
  });

  it("preserves 100% of sections across every pair of the 6 platform themes (lossless switching)", () => {
    const seeded = applyVerticalBlueprint({
      businessName: "PT Nusantara Terpadu",
      blueprintId: "b2b_corporate",
      whatsappPhone: "081234567890",
      city: "Jakarta",
    });

    let currentTheme: string = "compro";
    let currentSections = seeded.sections;

    for (const targetTheme of PLATFORM_THEME_IDS) {
      const switched = switchPageThemeLosslessly({
        fromThemeId: currentTheme,
        toThemeId: targetTheme,
        sections: currentSections,
        businessCategory: "b2b_corporate",
      });
      expect(switched.lossless).toBe(true);
      expect(switched.droppedCount).toBe(0);
      expect(switched.preservedCount).toBe(seeded.sections.length);
      expect(switched.sections.map((s) => s.id)).toEqual(seeded.sections.map((s) => s.id));
      currentTheme = targetTheme;
      currentSections = switched.sections;
    }
  });

  it("passes static isolation audit and contains zero hardcoded unverified claims across all 6 platform themes", () => {
    const forbiddenHardcodedClaims = [
      "Showroom Resmi",
      "Unit Terverifikasi",
      "Biro Perjalanan Resmi",
      "Jadwal Terverifikasi",
      "Katalog Resmi",
    ];

    const themeFiles: { filePath: string; content: string }[] = [];
    for (const id of PLATFORM_THEME_IDS) {
      const dir = path.join(REPO_ROOT, "apps/web/src/themes", id);
      const files = walkFiles(dir, new Set([".ts", ".tsx", ".astro", ".css"]));
      expect(files.length).toBeGreaterThanOrEqual(4);
      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        const rel = path.relative(REPO_ROOT, file);
        if (!file.endsWith(".css")) {
          themeFiles.push({ filePath: rel, content });
        }
        expect(content, `${rel} must never reference Base UI`).not.toContain("@base-ui/react");
        expect(content, `${rel} must never reference Radix`).not.toContain("@radix-ui/");
        expect(content, `${rel} must never reference Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
        if (file.endsWith("Layout.astro")) {
          for (const claim of forbiddenHardcodedClaims) {
            expect(content, `${rel} must not hardcode unverified claim "${claim}"`).not.toContain(
              claim,
            );
          }
        }
      }
    }

    const audit = auditCustomThemeSourceFiles(themeFiles);
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(true);

    const onboardingDir = path.join(REPO_ROOT, "apps/web/src/components/admin/onboarding");
    const adminFiles = walkFiles(onboardingDir, new Set([".ts", ".tsx"]));
    expect(adminFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of adminFiles) {
      const content = fs.readFileSync(file, "utf8");
      const rel = path.relative(REPO_ROOT, file);
      expect(content, `${rel} forbidden @radix-ui`).not.toContain("@radix-ui/");
      expect(content, `${rel} forbidden asChild`).not.toMatch(/\basChild\b/);
      expect(content, `${rel} forbidden Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});

describe("TASK-093 Unit: Dismissible 5-Step Guided Dashboard Onboarding Checklist & Copy Card", () => {
  const baseFacts = {
    handle: "karya-nusantara",
    offeringMenuLabel: "Layanan",
    hasBusinessProfileAndWhatsApp: false,
    hasLogo: false,
    hasOfferingOrPage: false,
    hasReviewedTheme: false,
    hasPublishedSite: false,
  } as const;

  it("tracks completion, dismissal, restore, strict schema uniqueness, ISO timestamps, and JSON persistence", () => {
    expect(GUIDED_ONBOARDING_STEP_IDS).toEqual([
      "profile_whatsapp",
      "logo",
      "offering_page",
      "theme",
      "publish",
    ]);

    // Schema rejects duplicate step IDs, overlapping completed/dismissed IDs, and non-ISO updatedAt
    expect(
      GuidedOnboardingChecklistStateSchema.safeParse({
        version: 1,
        completedStepIds: ["logo", "logo"],
        dismissedStepIds: [],
        dismissedAll: false,
        updatedAt: null,
      }).success,
    ).toBe(false);
    expect(
      GuidedOnboardingChecklistStateSchema.safeParse({
        version: 1,
        completedStepIds: ["logo"],
        dismissedStepIds: ["logo"],
        dismissedAll: false,
        updatedAt: null,
      }).success,
    ).toBe(false);
    expect(
      GuidedOnboardingChecklistStateSchema.safeParse({
        version: 1,
        completedStepIds: [],
        dismissedStepIds: [],
        dismissedAll: false,
        updatedAt: "not-a-timestamp",
      }).success,
    ).toBe(false);

    let state = createInitialGuidedChecklistState();
    let summary = evaluateGuidedOnboardingChecklist(baseFacts, state);
    expect(summary.totalCount).toBe(5);
    expect(summary.completedCount).toBe(0);
    expect(summary.isVisible).toBe(true);
    expect(summary.steps.map((s) => s.label)).toEqual([
      "Profil & WhatsApp",
      "Logo",
      "Penawaran/Halaman",
      "Tema",
      "Publikasikan",
    ]);

    state = completeGuidedChecklistStep(state, "profile_whatsapp", "2026-11-23T10:00:00.000Z");
    state = dismissGuidedChecklistStep(state, "logo", "2026-11-23T10:01:00.000Z");

    const raw = serializeGuidedChecklistState(state);
    const restored = parseGuidedChecklistState(raw);
    expect(restored).toEqual(state);

    summary = evaluateGuidedOnboardingChecklist(baseFacts, restored);
    expect(summary.completedCount).toBe(1);
    expect(summary.dismissedCount).toBe(1);
    expect(summary.resolvedCount).toBe(2);
    expect(summary.percentComplete).toBe(20);

    state = resetGuidedChecklistStep(restored, "logo", "2026-11-23T10:02:00.000Z");
    expect(evaluateGuidedOnboardingChecklist(baseFacts, state).steps[1]?.status).toBe("pending");

    state = dismissAllGuidedChecklist(state, "2026-11-23T10:03:00.000Z");
    expect(evaluateGuidedOnboardingChecklist(baseFacts, state).isVisible).toBe(false);

    state = restoreGuidedChecklist(state, "2026-11-23T10:04:00.000Z");
    expect(evaluateGuidedOnboardingChecklist(baseFacts, state).isVisible).toBe(true);

    expect(parseGuidedChecklistState("{not-valid-json")).toEqual(
      createInitialGuidedChecklistState(),
    );
  });

  it("builds dual Google Business Profile + Bing Places copy card truthfully without fabricating missing hours or address", () => {
    const completeCard = buildDualLocalListingsCopyCard({
      businessName: "Kedai Kopi Nusantara",
      categoryLabel: "Kafe & Kedai Kopi",
      address: "Jl. Braga No. 45, Bandung",
      weekdayHours: "Senin–Jumat 08.00–22.00 WIB",
      holidayHours: "Sabtu–Minggu 08.00–23.00 WIB",
      whatsappE164: "+6281234567890",
      websiteUrl: "https://kopi-nusantara.situsku.click/",
    });

    expect(completeCard.platforms).toEqual(["Google Business Profile", "Bing Places"]);
    expect(completeCard.callsExternalApi).toBe(false);
    expect(completeCard.copyPlainText).toContain("Jl. Braga No. 45, Bandung");
    expect(completeCard.copyPlainText).toContain("Senin–Jumat 08.00–22.00 WIB");
    expect(completeCard.copyPlainText).toContain("Sabtu–Minggu 08.00–23.00 WIB");

    // Partial card: MUST NOT fabricate default hours or address in `copyPlainText`
    const partialCard = buildDualLocalListingsCopyCard({
      businessName: "Studio Baru",
      categoryLabel: "Usaha Lokal",
      address: null,
      weekdayHours: null,
      holidayHours: null,
      whatsappE164: "+6281234567890",
      websiteUrl: "https://studio-baru.situsku.click/",
    });
    expect(partialCard.address).toContain("Belum diisi");
    expect(partialCard.weekdayHours).toContain("Belum diisi");
    expect(partialCard.holidayHours).toContain("Belum diisi");
    expect(partialCard.copyPlainText).not.toContain("Belum diisi");
    expect(partialCard.copyPlainText).not.toContain("Alamat:");
    expect(partialCard.copyPlainText).not.toContain("Jam Hari Kerja:");
    expect(partialCard.copyPlainText).not.toContain("09.00–17.00");
  });
});
