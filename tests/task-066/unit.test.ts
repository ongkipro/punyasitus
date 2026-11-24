import fs from "node:fs";
import path from "node:path";
import {
  SERVICE_PRICING_MODES,
  ServiceConsultationAttributesSchema,
} from "@punyasitus/core/catalog/service";
import {
  canPublishTravelPackage,
  formatTravelDateOnlyIndonesian,
  isValidTravelDateOnly,
  TravelPackageAttributesSchema,
  UMRAH_COUNSEL_GATE_REQUIRED,
  UMRAH_LICENSE_REQUIRED,
  UMRAH_OPERATOR_VERIFICATION_REQUIRED,
} from "@punyasitus/core/catalog/travel";
import {
  ALL_VERTICAL_PRESET_IDS,
  ApplyVerticalStarterPresetInputSchema,
  buildMultiOutletStarterPreset,
  buildProfessionalServicesStarterPreset,
  buildTravelUmrahStarterPreset,
  buildVerticalStarterComposition,
  computeVerticalPresetSetupHash,
  evaluateVerticalLaunchChecklist,
  GBP_CHECKLIST_STEP_ID,
  GBP_OFFICIAL_HELP_URLS,
  getVerticalStarterPresetCatalogEntry,
  isM1AvailablePresetId,
  M2_VERTICAL_PRESET_IDS,
  PresetDomainError,
  resolveCanonicalVerticalPresetId,
  SAMPLE_COPY_PHRASE,
  STARTER_PRESET_CATALOG,
  toStorageStarterPresetId,
  validateVerticalPresetSelectivePublish,
  VERTICAL_STARTER_PRESET_CATALOG,
} from "@punyasitus/core/presets/index";
import { PERMENKES_TESTIMONIALS_WARNING_CODE } from "@punyasitus/core/theme/sections";
import { validateOutletCreatePayload } from "@punyasitus/db/outlets/schema";
import { TENANT_0012_STARTER_PRESETS_SQL } from "@punyasitus/db/presets/migrations";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-066 Unit: M2 Additional Vertical Starter Presets (REQ-047)", () => {
  it("preserves M1 catalog backward compatibility while exposing all 4 vertical presets for M2", () => {
    // M1 TASK-043 contract remains 100% intact
    expect(STARTER_PRESET_CATALOG.filter((e) => e.availableInM1).map((e) => e.id)).toEqual([
      "company_profile",
    ]);
    expect(isM1AvailablePresetId("company_profile")).toBe(true);
    expect(isM1AvailablePresetId("travel")).toBe(false);

    // M2 catalog exposes all 4 verticals cleanly
    expect(ALL_VERTICAL_PRESET_IDS).toEqual([
      "company_profile",
      "professional_services",
      "travel_umrah",
      "multi_outlet",
    ]);
    expect(M2_VERTICAL_PRESET_IDS).toEqual([
      "professional_services",
      "travel_umrah",
      "multi_outlet",
    ]);
    expect(VERTICAL_STARTER_PRESET_CATALOG.map((e) => e.id)).toEqual([
      "company_profile",
      "professional_services",
      "travel_umrah",
      "multi_outlet",
    ]);

    // Canonical <-> storage alias mapping (zero SQL migrations needed)
    expect(resolveCanonicalVerticalPresetId("services")).toBe("professional_services");
    expect(resolveCanonicalVerticalPresetId("professional_services")).toBe("professional_services");
    expect(resolveCanonicalVerticalPresetId("travel")).toBe("travel_umrah");
    expect(resolveCanonicalVerticalPresetId("travel_umrah")).toBe("travel_umrah");
    expect(resolveCanonicalVerticalPresetId("outlets")).toBe("multi_outlet");
    expect(resolveCanonicalVerticalPresetId("multi_outlet")).toBe("multi_outlet");
    expect(resolveCanonicalVerticalPresetId("unknown_vertical")).toBeNull();

    expect(toStorageStarterPresetId("professional_services")).toBe("services");
    expect(toStorageStarterPresetId("travel_umrah")).toBe("travel");
    expect(toStorageStarterPresetId("multi_outlet")).toBe("outlets");
    expect(getVerticalStarterPresetCatalogEntry("travel_umrah")?.recommendedThemeId).toBe("travel");
  });

  it("builds professional_services preset validated against TASK-035 ServiceConsultationAttributesSchema with ZERO fabricated prices/claims/reviews", () => {
    const built = buildProfessionalServicesStarterPreset({
      businessName: "Kantor Konsultan Bintang Mandiri",
      businessCategory: "LocalBusiness",
    });

    expect(built.presetId).toBe("professional_services");
    expect(built.storagePresetId).toBe("services");
    expect(built.sections.map((s) => s.type)).toEqual([
      "hero",
      "services_grid",
      "features",
      "about",
      "gallery",
      "faq",
      "contact_location",
    ]);
    expect(built.secondaryPages).toHaveLength(1);
    expect(built.secondaryPages[0]?.status).toBe("draft");
    expect(built.secondaryPages[0]?.title).toContain(SAMPLE_COPY_PHRASE);

    // Starter service offering validates strictly against TASK-035 ServiceConsultationAttributesSchema!
    const svc = built.starterServiceOffering;
    expect(svc).not.toBeNull();
    expect(svc!.status).toBe("draft");
    expect(svc!.priceMode).toBe("on_request");
    expect(svc!.price).toBeNull();
    expect(svc!.title).toContain(SAMPLE_COPY_PHRASE);
    expect(svc!.summary).toContain(SAMPLE_COPY_PHRASE);

    const parsedAttrs = ServiceConsultationAttributesSchema.safeParse(svc!.serviceAttributes);
    expect(parsedAttrs.success).toBe(true);
    expect(svc!.serviceAttributes.pricingMode).toBe("inquiry");
    expect(svc!.serviceAttributes.basePriceIdr).toBeUndefined();
    expect(svc!.serviceAttributes.specialistCta).toBeUndefined();
    expect(svc!.serviceAttributes.pricingTiers.length).toBeGreaterThanOrEqual(2);
    for (const tier of svc!.serviceAttributes.pricingTiers) {
      expect(tier.pricingMode).toBe("inquiry");
      expect(tier.priceIdr).toBeUndefined();
      expect(tier.name).toContain(SAMPLE_COPY_PHRASE);
    }
    expect(svc!.serviceAttributes.processSteps.length).toBeGreaterThanOrEqual(3);
    for (const step of svc!.serviceAttributes.processSteps) {
      expect(step.title).toContain(SAMPLE_COPY_PHRASE);
      expect(step.summary).toContain(SAMPLE_COPY_PHRASE);
    }
    expect(svc!.supportedPricingModes.map((m) => m.mode)).toEqual([...SERVICE_PRICING_MODES]);

    // Zero fabricated testimonials/portfolio/milestones
    const about = built.sections.find((s) => s.type === "about");
    const portfolio = built.sections.find((s) => s.type === "gallery");
    expect(about?.type === "about" && about.config.milestones).toEqual([]);
    expect(portfolio?.type === "gallery" && portfolio.config.items).toEqual([]);
    expect(built.sampleSectionIds).toContain("svc-hero");
    expect(built.sampleSectionIds).toContain("svc-process");
    expect(built.sampleSectionIds).toContain("svc-about");

    // Launch checklist contains services-specific steps
    const checklist = evaluateVerticalLaunchChecklist({
      presetId: "professional_services",
      handle: "bintang-konsultan",
      siteTitle: "Kantor Konsultan Bintang Mandiri",
      businessName: "Kantor Konsultan Bintang Mandiri",
      hasCustomizedDraftSection: false,
      nonTrashedPagesCount: 2,
      nonTrashedOfferingsCount: 1,
      serviceOfferingsCount: 1,
      publishedServiceOfferingsCount: 0,
      whatsappE164: null,
      phone: null,
      email: null,
      hasPrivacyPage: false,
      hasPreviewedPreset: false,
      activeCustomHostname: null,
      fallbackHost: "bintang-konsultan.situsku.click",
    });
    expect(checklist.items.map((i) => i.id)).toContain("services_pricing_tiers");
    expect(checklist.items.map((i) => i.id)).toContain("services_process_steps");
  });

  it("builds travel_umrah preset validated against TASK-020 TravelPackageAttributesSchema with general_tour only & DEC-042 SK PPIU gate guidance", () => {
    const built = buildTravelUmrahStarterPreset({
      businessName: "PT Jelajah Nusantara Wisata",
      businessCategory: "TravelAgency",
    });

    expect(built.presetId).toBe("travel_umrah");
    expect(built.storagePresetId).toBe("travel");
    expect(built.sections.map((s) => s.type)).toEqual([
      "hero",
      "tours_grid",
      "features",
      "about",
      "gallery",
      "faq",
      "contact_location",
    ]);
    expect(built.secondaryPages).toHaveLength(1);
    expect(built.secondaryPages[0]?.status).toBe("draft");

    // Starter offering is STRICTLY general_tour draft, validated by TravelPackageAttributesSchema!
    const travel = built.starterTravelOffering;
    expect(travel).not.toBeNull();
    expect(travel!.status).toBe("draft");
    expect(travel!.priceMode).toBe("on_request");
    expect(travel!.price).toBeNull();
    expect(travel!.title).toContain(SAMPLE_COPY_PHRASE);

    const parsedAttrs = TravelPackageAttributesSchema.safeParse(travel!.travelAttributes);
    expect(parsedAttrs.success).toBe(true);
    expect(travel!.travelAttributes.packageKind).toBe("general_tour");
    expect(travel!.travelAttributes.skPpiuNumber).toBeUndefined();
    expect(travel!.travelAttributes.skPihkNumber).toBeUndefined();
    expect(travel!.travelAttributes.airline).toBeUndefined();
    expect(travel!.travelAttributes.hotels).toBeUndefined();
    expect(travel!.travelAttributes.itinerary.length).toBe(3);
    for (const day of travel!.travelAttributes.itinerary) {
      expect(day.title).toContain(SAMPLE_COPY_PHRASE);
      expect(day.summary).toContain(SAMPLE_COPY_PHRASE);
    }

    // Date-only departures are calendar-valid YYYY-MM-DD and timezone-invariant
    expect(travel!.travelAttributes.departures?.length).toBeGreaterThanOrEqual(1);
    const firstDep = travel!.travelAttributes.departures![0]!;
    expect(isValidTravelDateOnly(firstDep.departureDate)).toBe(true);
    expect(formatTravelDateOnlyIndonesian(firstDep.departureDate)).toBe("15 Januari 2027");
    expect(firstDep.label).toContain(SAMPLE_COPY_PHRASE);

    // DEC-042 Umrah compliance guidance & fail-closed gate verification
    expect(travel!.umrahComplianceGuidance.defaultPackageKind).toBe("general_tour");
    expect(travel!.umrahComplianceGuidance.autoPublishesUmrah).toBe(false);
    expect(travel!.umrahComplianceGuidance.requiredGates).toEqual([
      UMRAH_LICENSE_REQUIRED,
      UMRAH_OPERATOR_VERIFICATION_REQUIRED,
      UMRAH_COUNSEL_GATE_REQUIRED,
    ]);
    expect(canPublishTravelPackage({ packageKind: "umrah" }, {}).allowed).toBe(false);

    // Launch checklist includes travel itinerary + DEC-042 SK PPIU gate item
    const checklist = evaluateVerticalLaunchChecklist({
      presetId: "travel_umrah",
      handle: "jelajah-wisata",
      siteTitle: "PT Jelajah Nusantara Wisata",
      businessName: "PT Jelajah Nusantara Wisata",
      hasCustomizedDraftSection: false,
      nonTrashedPagesCount: 2,
      nonTrashedOfferingsCount: 1,
      tourOfferingsCount: 1,
      publishedTourOfferingsCount: 0,
      hasUmrahSkPpiuVerified: false,
      whatsappE164: null,
      phone: null,
      email: null,
      hasPrivacyPage: false,
      hasPreviewedPreset: false,
      activeCustomHostname: null,
      fallbackHost: "jelajah-wisata.situsku.click",
    });
    expect(checklist.items.map((i) => i.id)).toContain("travel_itinerary_departures");
    expect(checklist.items.map((i) => i.id)).toContain("travel_umrah_ppiu_gate");
  });

  it("builds multi_outlet preset validated against TASK-019 outlet schema with ZERO fabricated addresses/coordinates/hours + GBP checklist", () => {
    const built = buildMultiOutletStarterPreset({
      businessName: "Kedai Kopi Nusantara",
      businessCategory: "LocalBusiness",
    });

    expect(built.presetId).toBe("multi_outlet");
    expect(built.storagePresetId).toBe("outlets");
    expect(built.sections.map((s) => s.type)).toEqual([
      "hero",
      "products_grid",
      "branches",
      "about",
      "gallery",
      "faq",
      "contact_location",
    ]);
    expect(built.secondaryPages).toHaveLength(1);
    expect(built.secondaryPages[0]?.status).toBe("draft");

    // Starter outlet template validates strictly against TASK-019 validateOutletCreatePayload!
    const outlet = built.starterOutletTemplate;
    expect(outlet).not.toBeNull();
    expect(outlet!.status).toBe("draft");
    expect(outlet!.active).toBe(false);
    expect(outlet!.name).toContain(SAMPLE_COPY_PHRASE);
    expect(outlet!.address).toContain(SAMPLE_COPY_PHRASE);
    expect(outlet!.latitude).toBeNull();
    expect(outlet!.longitude).toBeNull();
    expect(outlet!.phone).toBeNull();
    expect(outlet!.whatsappE164).toBeNull();
    expect(outlet!.mapsUrl).toBeNull();
    expect(outlet!.weeklyHours).toEqual([]);
    expect(outlet!.holidayHours).toEqual([]);

    const validatedOutlet = validateOutletCreatePayload(outlet);
    expect(validatedOutlet.ok).toBe(true);
    if (validatedOutlet.ok) {
      expect(validatedOutlet.data.status).toBe("draft");
      expect(validatedOutlet.data.active).toBe(false);
      expect(validatedOutlet.data.latitude).toBeNull();
      expect(validatedOutlet.data.longitude).toBeNull();
    }

    // Launch checklist includes multi-outlet hours + TASK-073 GBP step with official Google Help URL
    const checklist = evaluateVerticalLaunchChecklist({
      presetId: "multi_outlet",
      handle: "kopi-nusantara",
      siteTitle: "Kedai Kopi Nusantara",
      businessName: "Kedai Kopi Nusantara",
      hasCustomizedDraftSection: false,
      nonTrashedPagesCount: 2,
      nonTrashedOfferingsCount: 0,
      outletsCount: 1,
      publishedOutletsCount: 0,
      whatsappE164: null,
      phone: null,
      email: null,
      hasPrivacyPage: false,
      hasPreviewedPreset: false,
      activeCustomHostname: null,
      fallbackHost: "kopi-nusantara.situsku.click",
      googleMapsReviewUrl: null,
      hasPublishedGoogleMapsReviewUrl: false,
    });
    expect(checklist.items.map((i) => i.id)).toContain("outlets_directory_hours");
    const gbpItem = checklist.items.find((i) => i.id === GBP_CHECKLIST_STEP_ID);
    expect(gbpItem).toBeDefined();
    expect(gbpItem?.officialHelpUrl).toBe(GBP_OFFICIAL_HELP_URLS.addWebsiteToProfile);
    expect(gbpItem?.helpArticleHref).toBe(GBP_OFFICIAL_HELP_URLS.punyasitusHelpArticle);
  });

  it("enforces strict validation, sample-content publish blocking across all 3 M2 verticals, and Permenkes health-category handling", () => {
    // Reject unknown fields & missing setupKey/operationKey
    expect(
      ApplyVerticalStarterPresetInputSchema.safeParse({
        presetId: "travel_umrah",
        setupKey: "setup-001",
        rogue: true,
      }).success,
    ).toBe(false);
    expect(
      ApplyVerticalStarterPresetInputSchema.safeParse({
        presetId: "travel_umrah",
      }).success,
    ).toBe(false);
    expect(
      ApplyVerticalStarterPresetInputSchema.safeParse({
        presetId: "travel_umrah",
        setupKey: "setup-001",
        operationKey: "different-002",
      }).success,
    ).toBe(false);

    // Deterministic setup hash differs across tenantId / presetId / applyMode
    const hA = computeVerticalPresetSetupHash({
      tenantId: "01JT066TENANTA000000000001",
      presetId: "travel_umrah",
      applyMode: "preserve_existing",
    });
    const hB = computeVerticalPresetSetupHash({
      tenantId: "01JT066TENANTB000000000002",
      presetId: "travel_umrah",
      applyMode: "preserve_existing",
    });
    expect(hA).not.toBe(hB);

    // Sample CONTOH sections MUST be blocked from selective publish on every M2 vertical
    for (const presetId of M2_VERTICAL_PRESET_IDS) {
      const built = buildVerticalStarterComposition(presetId, {
        businessName: "PT Uji Vertikal",
      });
      const firstSampleId = built.sampleSectionIds[0]!;
      let errCaught: unknown = null;
      try {
        validateVerticalPresetSelectivePublish({
          presetId,
          draftSections: built.sections,
          selectedSectionIds: [firstSampleId],
        });
      } catch (err) {
        errCaught = err;
      }
      expect(errCaught).toBeInstanceOf(PresetDomainError);
      expect((errCaught as PresetDomainError).code).toBe("SAMPLE_CONTENT_BLOCKED");
    }

    // Company profile via vertical dispatcher preserves Permenkes health warning
    const healthCompro = buildVerticalStarterComposition("company_profile", {
      businessName: "Klinik Medika",
      businessCategory: "Klinik Kesehatan",
    });
    expect(healthCompro.isHealthCategory).toBe(true);
    expect(healthCompro.warnings.some((w) => w.code === PERMENKES_TESTIMONIALS_WARNING_CODE)).toBe(
      true,
    );
  });

  it("enforces zero Radix, zero asChild, zero Sparkles, explicit htmlFor/id, and zero SQL migration drift", () => {
    const sqlOnDisk = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/tenant/0012_starter_presets.sql"),
      "utf8",
    );
    expect(TENANT_0012_STARTER_PRESETS_SQL).toBe(sqlOnDisk);

    const uiFiles = [
      "apps/web/src/pages/dashboard/[handle]/onboarding/_VerticalOnboardingWorkspace.tsx",
      "apps/web/src/pages/dashboard/[handle]/onboarding/_StarterPresetWizard.tsx",
      "apps/web/src/pages/dashboard/[handle]/onboarding/index.astro",
    ];
    for (const rel of uiFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(content, `${rel} must not import Radix`).not.toMatch(/@radix-ui\//);
      expect(content, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
      expect(content, `${rel} must not use Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }

    // Verify explicit htmlFor bindings exist in _VerticalOnboardingWorkspace.tsx
    const workspaceTsx = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "apps/web/src/pages/dashboard/[handle]/onboarding/_VerticalOnboardingWorkspace.tsx",
      ),
      "utf8",
    );
    expect(workspaceTsx).toContain("htmlFor=");
  });
});
