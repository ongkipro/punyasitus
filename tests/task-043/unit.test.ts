import fs from "node:fs";
import path from "node:path";
import {
  ApplyStarterPresetInputSchema,
  buildCompanyProfileStarterComposition,
  computePresetOperationHash,
  computeSampleSectionIds,
  convertValidatedSectionToPublicPageSectionDto,
  detectSampleClaimsInSection,
  disableSampleSectionsForPageDraft,
  evaluatePresetChecklist,
  isM1AvailablePresetId,
  mergePublishedPageSectionsNonDestructively,
  mergeStarterPresetDraftSections,
  PresetDomainError,
  PreviewStarterPresetInputSchema,
  PublishStarterPresetInputSchema,
  STARTER_PRESET_CATALOG,
  UpdatePresetDraftInputSchema,
  validatePresetSelectivePublish,
} from "@punyasitus/core/presets/index";
import {
  PERMENKES_TESTIMONIALS_WARNING_CODE,
  SectionRegistryValidationError,
} from "@punyasitus/core/theme/sections";
import { TENANT_0012_STARTER_PRESETS_SQL } from "@punyasitus/db/presets/migrations";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-043 Unit: Company-Profile Starter Preset & Selective Publication Guardrails", () => {
  it("exposes company_profile in M1 and explicitly defers services/travel/outlets to M2 TASK-066", () => {
    const m1Entries = STARTER_PRESET_CATALOG.filter((e) => e.availableInM1);
    expect(m1Entries.map((e) => e.id)).toEqual(["company_profile"]);
    expect(isM1AvailablePresetId("company_profile")).toBe(true);
    expect(isM1AvailablePresetId("services")).toBe(false);
    expect(isM1AvailablePresetId("travel")).toBe(false);
    expect(isM1AvailablePresetId("outlets")).toBe(false);

    const deferred = STARTER_PRESET_CATALOG.filter((e) => !e.availableInM1);
    expect(deferred.map((e) => e.id)).toEqual(["services", "travel", "outlets"]);
    for (const item of deferred) {
      expect(item.milestone).toBe("M2");
      expect(item.deferredTask).toBe("TASK-066");
    }
  });

  it("builds all 8 company-profile sections with visible sample markers and ZERO fabricated claims", () => {
    const built = buildCompanyProfileStarterComposition({
      businessName: "PT Karya Nusantara Mandiri",
      businessCategory: "LocalBusiness",
    });

    expect(built.presetId).toBe("company_profile");
    expect(built.sections.map((s) => s.type)).toEqual([
      "hero",
      "about",
      "services_grid",
      "gallery",
      "trust_logos",
      "testimonials",
      "faq",
      "contact_location",
    ]);

    // Zero fabricated reviews, partner logos, portfolio photos, milestones, or offerings!
    const about = built.sections.find((s) => s.type === "about");
    const services = built.sections.find((s) => s.type === "services_grid");
    const portfolio = built.sections.find((s) => s.type === "gallery");
    const trustLogos = built.sections.find((s) => s.type === "trust_logos");
    const testimonials = built.sections.find((s) => s.type === "testimonials");

    expect(about?.type === "about" && about.config.milestones).toEqual([]);
    expect(services?.type === "services_grid" && services.config.items).toEqual([]);
    expect(portfolio?.type === "gallery" && portfolio.config.items).toEqual([]);
    expect(trustLogos?.type === "trust_logos" && trustLogos.config.items).toEqual([]);
    expect(testimonials?.type === "testimonials" && testimonials.config.items).toEqual([]);
    expect(testimonials?.enabled).toBe(false);

    // Sample starter copy MUST be visibly flagged in sampleSectionIds
    expect(built.sampleSectionIds).toContain("preset-hero");
    expect(built.sampleSectionIds).toContain("preset-about");
    expect(built.sampleSectionIds).toContain("preset-faq");
    expect(built.sampleSectionIds).toContain("preset-contact");
  });

  it("enforces Permenkes health-category default-off and compliance warning on testimonials", () => {
    const built = buildCompanyProfileStarterComposition({
      businessName: "Klinik Sehat Sentosa",
      businessCategory: "Klinik Kesehatan",
    });

    expect(built.isHealthCategory).toBe(true);
    const testimonials = built.sections.find((s) => s.type === "testimonials");
    expect(testimonials?.enabled).toBe(false);
    expect(built.warnings.some((w) => w.code === PERMENKES_TESTIMONIALS_WARNING_CODE)).toBe(true);
  });

  it("enforces strict Zod v4 schemas rejecting unknown fields and invalid confirm/operationKey", () => {
    // Unknown field rejected by .strict()
    expect(
      ApplyStarterPresetInputSchema.safeParse({
        presetId: "company_profile",
        operationKey: "op-valid-001",
        extraField: "nope",
      }).success,
    ).toBe(false);

    // Invalid operationKey rejected
    expect(
      ApplyStarterPresetInputSchema.safeParse({
        presetId: "company_profile",
        operationKey: "a!",
      }).success,
    ).toBe(false);

    // Valid apply input passes with default applyMode
    const validApply = ApplyStarterPresetInputSchema.safeParse({
      presetId: "company_profile",
      operationKey: "op-compro-2026-01",
    });
    expect(validApply.success).toBe(true);
    if (validApply.success) {
      expect(validApply.data.applyMode).toBe("preserve_existing");
    }

    // Publish requires explicit confirm: true
    expect(
      PublishStarterPresetInputSchema.safeParse({
        presetId: "company_profile",
        selectedSectionIds: ["preset-hero"],
        expectedVersion: 1,
        confirm: false,
      }).success,
    ).toBe(false);

    expect(
      UpdatePresetDraftInputSchema.safeParse({
        expectedVersion: 1,
        sections: [],
        rogue: true,
      }).success,
    ).toBe(false);

    expect(
      PreviewStarterPresetInputSchema.safeParse({
        presetId: "company_profile",
        rogue: 123,
      }).success,
    ).toBe(false);
  });

  it("blocks publishing any selected section containing sample claims, while allowing validated subset without optional modules", () => {
    const built = buildCompanyProfileStarterComposition({
      businessName: "PT Surya Konstruksi",
      businessCategory: "LocalBusiness",
      address: "Jl. Sudirman No. 12, Jakarta",
      phone: "021-5551234",
      email: "halo@suryakonstruksi.co.id",
    });

    // Attempting to publish unedited hero + about MUST throw SAMPLE_CONTENT_BLOCKED
    let blockedErr: unknown = null;
    try {
      validatePresetSelectivePublish({
        presetId: "company_profile",
        draftSections: built.sections,
        selectedSectionIds: ["preset-hero", "preset-about", "preset-contact"],
      });
    } catch (err) {
      blockedErr = err;
    }
    expect(blockedErr).toBeInstanceOf(PresetDomainError);
    expect((blockedErr as PresetDomainError).code).toBe("SAMPLE_CONTENT_BLOCKED");
    expect((blockedErr as PresetDomainError).fields.some((f) => f.sectionId === "preset-hero")).toBe(
      true,
    );

    // Replace sample copy ONLY on hero & contact; leave optional sections (services, portfolio, trust_logos, testimonials, faq) unselected!
    const customizedSections = built.sections.map((section) => {
      if (section.id === "preset-hero" && section.type === "hero") {
        return {
          ...section,
          config: {
            ...section.config,
            eyebrow: "Profil Perusahaan",
            heading: "PT Surya Konstruksi — Mitra Konstruksi Komersial",
            subheading: "Layanan rancang bangun dan renovasi gedung perkantoran di Jabodetabek.",
          },
        };
      }
      return section;
    });

    expect(detectSampleClaimsInSection(customizedSections[0]!)).toEqual([]);
    expect(computeSampleSectionIds(customizedSections)).not.toContain("preset-hero");
    expect(computeSampleSectionIds(customizedSections)).not.toContain("preset-contact");
    expect(computeSampleSectionIds(customizedSections)).toContain("preset-faq");

    // Missing optional modules (gallery, trust_logos, testimonials, faq, services_grid) MUST NOT block publication!
    const validPub = validatePresetSelectivePublish({
      presetId: "company_profile",
      draftSections: customizedSections,
      selectedSectionIds: ["preset-hero", "preset-contact"],
    });
    expect(validPub.selectedSections.map((s) => s.id)).toEqual(["preset-hero", "preset-contact"]);
    expect(validPub.unpublishedDraftSectionIds).toContain("preset-faq");
    expect(validPub.missingOptionalSectionIds).toEqual([
      "preset-services",
      "preset-portfolio",
      "preset-trust-logos",
      "preset-testimonials",
      "preset-faq",
    ]);

    // Convert validated sections to PublicPageSectionDto cleanly
    const publicDtos = validPub.selectedSections.map((s) =>
      convertValidatedSectionToPublicPageSectionDto(s),
    );
    expect(publicDtos[0]?.kind).toBe("hero");
    expect(publicDtos[1]?.kind).toBe("contact");
  });

  it("rejects unsupported presets, invalid section selections, and unsafe URLs safely", () => {
    const built = buildCompanyProfileStarterComposition({ businessName: "PT Aman" });

    expect(() =>
      validatePresetSelectivePublish({
        presetId: "travel",
        draftSections: built.sections,
        selectedSectionIds: ["preset-hero"],
      }),
    ).toThrow(PresetDomainError);

    expect(() =>
      validatePresetSelectivePublish({
        presetId: "company_profile",
        draftSections: built.sections,
        selectedSectionIds: ["nonexistent-section"],
      }),
    ).toThrow(PresetDomainError);

    // Unsafe URL injected into a draft section must fail SectionRegistryValidationError
    const poisoned = built.sections.map((section) =>
      section.id === "preset-hero" && section.type === "hero"
        ? {
            ...section,
            config: {
              ...section.config,
              eyebrow: "Resmi",
              heading: "PT Aman",
              subheading: "Layanan resmi.",
              primaryCta: {
                label: "Klik",
                href: "javascript:alert(1)",
                variant: "primary" as const,
                openInNewTab: false,
              },
            },
          }
        : section,
    );

    expect(() =>
      validatePresetSelectivePublish({
        presetId: "company_profile",
        draftSections: poisoned,
        selectedSectionIds: ["preset-hero"],
      }),
    ).toThrow(SectionRegistryValidationError);
  });

  it("computes deterministic operation hashes and evaluates all 6 readiness checklist items", () => {
    const h1 = computePresetOperationHash({
      presetId: "company_profile",
      applyMode: "preserve_existing",
    });
    const h2 = computePresetOperationHash({
      presetId: "company_profile",
      applyMode: "preserve_existing",
    });
    const h3 = computePresetOperationHash({
      presetId: "company_profile",
      applyMode: "merge_draft",
    });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);

    const summary = evaluatePresetChecklist({
      handle: "surya-konstruksi",
      siteTitle: "PT Surya Konstruksi",
      businessName: "PT Surya Konstruksi",
      hasCustomizedDraftSection: true,
      nonTrashedPagesCount: 1,
      nonTrashedOfferingsCount: 0,
      whatsappE164: "+628123456789",
      phone: null,
      email: "halo@surya.co.id",
      hasPrivacyPage: false,
      hasPreviewedPreset: true,
      activeCustomHostname: null,
      fallbackHost: "surya-konstruksi.situsku.click",
    });

    expect(summary.items.map((i) => i.id)).toEqual([
      "identity",
      "first_content",
      "contact_wa",
      "privacy",
      "preview",
      "domain",
    ]);
    expect(summary.readyForFirstPublish).toBe(true);
    expect(summary.completedCount).toBe(4);
    expect(summary.items.find((i) => i.id === "privacy")?.status).toBe("optional_pending");
    expect(summary.items.find((i) => i.id === "domain")?.status).toBe("optional_pending");
  });

  it("keeps bundled migration 0012 byte-for-byte identical to SQL file and enforces zero Radix / zero asChild in UI", () => {
    const sqlOnDisk = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/tenant/0012_starter_presets.sql"),
      "utf8",
    );
    expect(TENANT_0012_STARTER_PRESETS_SQL).toBe(sqlOnDisk);

    const uiFiles = [
      "apps/web/src/pages/dashboard/[handle]/onboarding/_StarterPresetWizard.tsx",
      "apps/web/src/pages/dashboard/[handle]/onboarding/index.astro",
      "apps/web/src/pages/dashboard/[handle]/appearance/presets/index.astro",
    ];
    for (const rel of uiFiles) {
      const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(content).not.toMatch(/@radix-ui\//);
      expect(content).not.toMatch(/\basChild\b/);
    }
  });

  it("disables sample sections for pages.draft_sections_json and preserves existing content during non-destructive merges", () => {
    const built = buildCompanyProfileStarterComposition({
      businessName: "PT Karya Nusantara",
      businessCategory: "LocalBusiness",
      address: "Jl. Asia Afrika No. 8, Bandung",
    });

    // Finding #6: sample sections are strictly disabled for pages.draft_sections_json
    const safeForPageDraft = disableSampleSectionsForPageDraft(built.sections);
    for (const section of safeForPageDraft) {
      if (detectSampleClaimsInSection(section).length > 0) {
        expect(section.enabled).toBe(false);
      }
    }
    const enabledInPageDraft = safeForPageDraft.filter((s) => s.enabled);
    expect(enabledInPageDraft.every((s) => detectSampleClaimsInSection(s).length === 0)).toBe(true);

    // Finding #2: re-applying starter sections preserves user-edited draft sections
    const editedExisting = built.sections.slice(0, 2).map((s) =>
      s.id === "preset-hero" && s.type === "hero"
        ? {
            ...s,
            config: {
              ...s.config,
              eyebrow: "Resmi",
              heading: "Judul Kustom Pemilik",
              subheading: "Subjudul kustom yang tidak boleh hilang.",
            },
          }
        : s,
    );
    const mergedDraft = mergeStarterPresetDraftSections(editedExisting, built.sections);
    expect(mergedDraft.length).toBe(8);
    const heroAfterMerge = mergedDraft.find((s) => s.id === "preset-hero");
    expect(heroAfterMerge?.type === "hero" && heroAfterMerge.config.heading).toBe(
      "Judul Kustom Pemilik",
    );

    // Finding #1: publishing onto a populated homepage preserves existing live sections & singleton hero
    const existingLive = [
      {
        id: "existing-hero",
        kind: "hero" as const,
        heading: "Hero Publik Lama",
        subheading: "Tetap utuh",
        bodyHtml: null,
      },
      {
        id: "existing-cta",
        kind: "cta_band" as const,
        heading: "CTA Lama",
        subheading: null,
        bodyHtml: null,
      },
    ];
    const incomingPreset = [
      {
        id: "preset-hero",
        kind: "hero" as const,
        heading: "Hero Preset Baru",
        subheading: null,
        bodyHtml: null,
      },
      {
        id: "preset-about",
        kind: "about" as const,
        heading: "Tentang Preset Baru",
        subheading: null,
        bodyHtml: "<p>Profil resmi</p>",
      },
    ];
    const mergedPub = mergePublishedPageSectionsNonDestructively(existingLive, incomingPreset);
    expect(mergedPub.map((s) => s.id)).toEqual(["existing-hero", "existing-cta", "preset-about"]);
    expect(mergedPub.filter((s) => s.kind === "hero")).toHaveLength(1);
  });
});
