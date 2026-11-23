import { z } from "zod";
import {
  DEFAULT_WORKERS_AI_GATEWAY_ID,
  detectPiiInSelectedFields,
  type AiWritingPiiCheckResult,
  type AiWritingProviderPort,
  type AiWritingProviderRequest,
  type WorkersAiBindingLike,
} from "../../ai-writing/index.ts";
import { sanitizeRichTextHtml } from "../../content/index.ts";
import { ONBOARDING_VERTICAL_IDS } from "../index.ts";
import { B2B_BLUEPRINT_IDS, B2B_VERTICAL_BLUEPRINTS } from "../../presets/blueprints.ts";
import {
  computeSampleSectionIds,
  SAMPLE_MARKER_LABEL,
} from "../../presets/index.ts";
import {
  SECTION_REGISTRY_SCHEMA_VERSION,
  validatePageSections,
  type AnyValidatedPageSection,
} from "../../theme/sections.ts";
import {
  markAsContohDraft,
  parseAndSanitizeOnboardingAiDraftOutput,
} from "./fact-scrubber.ts";
import {
  EMPTY_ONBOARDING_BLUEPRINT_FACTS,
  ONBOARDING_AI_DRAFT_MARKER,
  ONBOARDING_AI_DRAFT_MAX_BUSINESS_NAME_CHARS,
  ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS,
  resolveDefaultBlueprintForVertical,
  type OnboardingAiDraftAnswers,
  type OnboardingAiDraftParseSuccess,
  type OnboardingAiDraftTextFields,
  type OnboardingBlueprintDraft,
  type OnboardingDraftServiceSummary,
} from "./types.ts";

/**
 * Pure Blueprint Builder, Prompt Composer & Draft Applicator for Onboarding AI Drafts
 * (`packages/core/src/onboarding/ai-draft/blueprint.ts`; REQ-109, PLAN §20.5, TASK-109).
 *
 * Hard invariants:
 * - Only offered when an AI writing provider binding (`env.AI` / `AiWritingProviderPort`) is configured.
 * - Uses ONLY the owner's 3 onboarding answers (businessName, vertical/blueprintId, shortDescription).
 * - Drafts ONLY narrative text fields of the chosen blueprint; every generated field is marked `CONTOH`.
 * - NEVER auto-publishes (`status: "draft"`, `published: false`, `autoPublished: false`).
 * - Facts (price, licence/permit numbers, reviews/testimonials, phone/WhatsApp, street addresses)
 *   ALWAYS stay empty / untouched.
 */

export const onboardingAiDraftRequestSchema = z
  .object({
    tenantId: z.string().trim().min(1, "ID situs wajib diisi.").max(64),
    action: z.enum(["generate", "skip"]).default("generate"),
    businessName: z
      .string()
      .trim()
      .min(2, "Nama bisnis minimal 2 karakter.")
      .max(
        ONBOARDING_AI_DRAFT_MAX_BUSINESS_NAME_CHARS,
        `Nama bisnis maksimal ${ONBOARDING_AI_DRAFT_MAX_BUSINESS_NAME_CHARS} karakter.`,
      ),
    vertical: z.enum(ONBOARDING_VERTICAL_IDS),
    blueprintId: z.enum(B2B_BLUEPRINT_IDS).optional(),
    shortDescription: z
      .string()
      .trim()
      .max(
        ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS,
        `Deskripsi singkat maksimal ${ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS} karakter.`,
      )
      .optional()
      .default(""),
  })
  .strict();

export type ValidatedOnboardingAiDraftRequest = z.infer<typeof onboardingAiDraftRequestSchema>;

/**
 * Determines whether the AI writing provider is configured for onboarding.
 * When `false`, onboarding proceeds seamlessly without showing or blocking on AI draft.
 */
export function isOnboardingAiProviderConfigured(
  runtimeEnv: {
    readonly AI?: WorkersAiBindingLike | null;
    readonly AI_ONBOARDING_ENABLED?: string;
  },
  overrideProvider?: AiWritingProviderPort | null,
): boolean {
  if (overrideProvider !== undefined) {
    return overrideProvider !== null;
  }
  const flag = runtimeEnv.AI_ONBOARDING_ENABLED?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  return Boolean(runtimeEnv.AI && typeof runtimeEnv.AI.run === "function");
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPlainTextFields(answers: OnboardingAiDraftAnswers): OnboardingAiDraftTextFields {
  const bp = B2B_VERTICAL_BLUEPRINTS[answers.blueprintId];
  const cleanName = answers.businessName.trim();
  const primaryLabel = bp.sidebarOffering.primaryMenuLabel;

  return {
    heroEyebrow: `${SAMPLE_MARKER_LABEL} ${bp.name}`,
    heroHeadline: `${SAMPLE_MARKER_LABEL} ${cleanName} — ${primaryLabel} Terpercaya`,
    heroSubheadline:
      "Contoh — ubah sebelum diterbitkan: jelaskan keunggulan usaha, cakupan layanan, dan cara pelanggan menghubungi tim Anda.",
    heroCtaLabel: `Lihat ${primaryLabel}`,
    aboutHeading: `${SAMPLE_MARKER_LABEL} Tentang ${cleanName}`,
    aboutSummary:
      "Contoh — ubah sebelum diterbitkan: ceritakan profil singkat usaha, fokus layanan utama, dan komitmen kualitas Anda tanpa klaim berlebihan.",
    serviceSummaries: [
      {
        title: `${SAMPLE_MARKER_LABEL} ${primaryLabel} Utama`,
        description:
          "Contoh — ubah sebelum diterbitkan: ringkas cakupan layanan atau produk unggulan usaha Anda.",
      },
      {
        title: `${SAMPLE_MARKER_LABEL} Konsultasi & Pemesanan`,
        description:
          "Contoh — ubah sebelum diterbitkan: jelaskan alur konsultasi awal dan pengiriman pesanan.",
      },
      {
        title: `${SAMPLE_MARKER_LABEL} Dukungan Pelanggan`,
        description:
          "Contoh — ubah sebelum diterbitkan: sampaikan standar pelayanan dan pendampingan tim Anda.",
      },
    ],
  };
}

function buildSectionsFromTextFields(
  answers: OnboardingAiDraftAnswers,
  textFields: OnboardingAiDraftTextFields,
): {
  readonly sections: readonly AnyValidatedPageSection[];
  readonly sampleSectionIds: readonly string[];
} {
  const bp = B2B_VERTICAL_BLUEPRINTS[answers.blueprintId];
  const primaryRoute = bp.sidebarOffering.primaryRoutePath;
  const primaryLabel = bp.sidebarOffering.primaryMenuLabel;
  const idPrefix = `onb-${bp.id.replace(/_/g, "-")}`;

  const rawSections: unknown[] = [
    {
      id: `${idPrefix}-hero`,
      type: "hero",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      order: 0,
      config: {
        eyebrow: textFields.heroEyebrow,
        heading: textFields.heroHeadline,
        subheading: textFields.heroSubheadline,
        primaryCta: {
          label: textFields.heroCtaLabel,
          href: primaryRoute,
          variant: "primary",
        },
        secondaryCta: {
          label: "Hubungi Kami",
          href: "#kontak",
          variant: "secondary",
        },
        highlights: [],
      },
    },
    {
      id: `${idPrefix}-about`,
      type: "about",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      order: 1,
      config: {
        eyebrow: "Profil Usaha",
        heading: textFields.aboutHeading,
        subheading: textFields.aboutSummary,
        bodyHtml: sanitizeRichTextHtml(`<p>${escapeHtml(textFields.aboutSummary)}</p>`),
        milestones: [],
      },
    },
    {
      id: `${idPrefix}-features`,
      type: "features",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      order: 2,
      config: {
        eyebrow: primaryLabel,
        heading: `${SAMPLE_MARKER_LABEL} Ringkasan ${primaryLabel}`,
        subheading: "Contoh — ubah sebelum diterbitkan agar sesuai dengan penawaran resmi Anda.",
        columns: 3,
        items: textFields.serviceSummaries.map((item, idx) => ({
          title: item.title,
          description: item.description,
          badge: `Draf ${idx + 1}`,
        })),
      },
    },
    {
      id: `${idPrefix}-offerings`,
      type:
        bp.sidebarOffering.primaryOfferingType === "product"
          ? "products_grid"
          : bp.sidebarOffering.primaryOfferingType === "tour"
            ? "tours_grid"
            : bp.sidebarOffering.primaryOfferingType === "vehicle"
              ? "vehicles_grid"
              : "services_grid",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      order: 3,
      config: {
        eyebrow: primaryLabel,
        heading: `Pilihan ${primaryLabel}`,
        subheading: `Tambahkan item ${primaryLabel.toLowerCase()} beserta harga resmi melalui dashboard.`,
        offeringType: bp.sidebarOffering.primaryOfferingType,
        limit: 6,
        itemSlugs: [],
        items: [],
        emptyMessage: `Belum ada ${primaryLabel.toLowerCase()} terbit.`,
        viewAllCta: {
          label: `Lihat Semua ${primaryLabel}`,
          href: primaryRoute,
          variant: "secondary",
        },
      },
    },
    {
      id: `${idPrefix}-testimonials`,
      type: "testimonials",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      order: 4,
      config: {
        eyebrow: "Ulasan",
        heading: "Ulasan Klien Asli",
        subheading:
          "Dinonaktifkan secara default. Tambahkan hanya ulasan asli pelanggan Anda — AI tidak pernah membuat testimoni.",
        items: [],
      },
    },
    {
      id: `${idPrefix}-contact`,
      type: "contact_location",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      order: 5,
      config: {
        eyebrow: "Kontak",
        heading: `Hubungi ${answers.businessName.trim()}`,
        subheading:
          "Lengkapi nomor WhatsApp, telepon, dan alamat lokasi usaha Anda di menu Pengaturan.",
        // Facts MUST stay omitted/empty here — never fabricated!
        branches: [],
      },
    },
  ];

  const validated = validatePageSections(rawSections, {
    businessCategory: bp.defaultBusinessCategory,
  });
  const sampleSectionIds = computeSampleSectionIds(validated.sections);

  return {
    sections: validated.sections,
    sampleSectionIds,
  };
}

/**
 * Builds the unchanged plain starter blueprint draft with ZERO fabricated facts.
 */
export function buildPlainOnboardingBlueprint(
  answersInput: Omit<OnboardingAiDraftAnswers, "blueprintId"> & {
    readonly blueprintId?: OnboardingAiDraftAnswers["blueprintId"];
  },
): OnboardingBlueprintDraft {
  const blueprintId =
    answersInput.blueprintId ?? resolveDefaultBlueprintForVertical(answersInput.vertical);
  const answers: OnboardingAiDraftAnswers = {
    businessName: answersInput.businessName.trim(),
    vertical: answersInput.vertical,
    blueprintId,
    shortDescription: answersInput.shortDescription?.trim() ?? "",
  };
  const bp = B2B_VERTICAL_BLUEPRINTS[blueprintId];
  const textFields = buildPlainTextFields(answers);
  const { sections, sampleSectionIds } = buildSectionsFromTextFields(answers, textFields);

  return {
    blueprintId,
    blueprintName: bp.name,
    vertical: answers.vertical,
    recommendedThemeId: bp.defaultThemeId,
    primaryMenuLabel: bp.sidebarOffering.primaryMenuLabel,
    source: "plain_blueprint",
    status: "draft",
    published: false,
    autoPublished: false,
    draftMarker: ONBOARDING_AI_DRAFT_MARKER,
    textFields,
    facts: EMPTY_ONBOARDING_BLUEPRINT_FACTS,
    sections,
    sampleSectionIds,
  };
}

/**
 * Reuses TASK-074's O(n) pre-send PII blocker on the owner's onboarding answers
 * BEFORE any quota reservation or AI provider call.
 */
export function detectPiiInOnboardingAnswers(
  answers: OnboardingAiDraftAnswers,
): AiWritingPiiCheckResult {
  const bp = B2B_VERTICAL_BLUEPRINTS[answers.blueprintId];
  return detectPiiInSelectedFields({
    title: answers.businessName,
    category: bp.name,
    ...(answers.shortDescription?.trim() ? { summary: answers.shortDescription.trim() } : {}),
  });
}

/**
 * Composes a minimized `AiWritingProviderRequest` compatible with TASK-074's
 * `AiWritingProviderPort` (`createCloudflareWorkersAiPort` / `env.AI`).
 * Passes ONLY the 3 onboarding answers (businessName, category/blueprint, shortDescription).
 */
export function buildOnboardingAiDraftProviderRequest(
  answers: OnboardingAiDraftAnswers,
  options: { readonly gatewayId?: string } = {},
): AiWritingProviderRequest {
  const bp = B2B_VERTICAL_BLUEPRINTS[answers.blueprintId];
  const cleanName = answers.businessName.trim();
  const cleanDesc = answers.shortDescription?.trim() ?? "";

  const systemPrompt = [
    "Anda adalah asisten penulisan draf awal website bisnis Indonesia untuk PunyaSitus.",
    "Tugas Anda: buat HANYA teks draf naratif (ditandai CONTOH) untuk blueprint yang dipilih dalam format JSON ketat tanpa Markdown.",
    "Kembalikan HANYA objek JSON dengan kunci berikut:",
    '{"heroEyebrow":"...","heroHeadline":"...","heroSubheadline":"...","heroCtaLabel":"...","aboutHeading":"...","aboutSummary":"...","serviceSummaries":[{"title":"...","description":"..."}]}',
    "Aturan wajib tanpa pengecualian:",
    "- Bahasa Indonesia profesional, ringkas, dan jelas. Maksimal 3 item di serviceSummaries.",
    "- DILARANG KERAS mengarang fakta: JANGAN pernah menulis harga/nominal Rp/IDR/USD, nomor izin/lisensi (NIB, SK Kemenag PPIU/PIHK, SIP/STR, ISO, SNI, BPOM, Halal, NPWP), ulasan/testimoni/rating bintang, nomor telepon/WhatsApp, email, atau alamat jalan.",
    "- Jangan tambahkan kunci JSON lain di luar daftar kunci di atas.",
    "- Semua teks akan ditandai sebagai draf CONTOH dan tidak pernah diterbitkan otomatis.",
  ].join("\n");

  const userLines = [
    `Jawaban 1 — Nama bisnis: ${cleanName}`,
    `Jawaban 2 — Blueprint / kategori usaha: ${bp.name} (${bp.targetSegment})`,
    `Jawaban 3 — Deskripsi singkat usaha: ${cleanDesc || `Usaha di bidang ${bp.name} (${bp.sidebarOffering.primaryMenuLabel})`}`,
    `Menu penawaran utama: ${bp.sidebarOffering.primaryMenuLabel}`,
  ];

  return {
    // Reuses TASK-074 `offering_description` slot (1,500 chars / 480 tokens) so DEC-028
    // `ai_writing_usage` table & `createCloudflareWorkersAiPort` work atomically with zero schema changes.
    fieldKind: "offering_description",
    vertical: answers.vertical,
    tone: "profesional",
    selectedFieldKeys: cleanDesc ? ["title", "category", "summary"] : ["title", "category"],
    selectedFields: {
      title: cleanName,
      category: bp.name,
      ...(cleanDesc ? { summary: cleanDesc } : {}),
    },
    systemPrompt,
    userPrompt: userLines.join("\n"),
    maxOutputChars: 1_500,
    maxTokens: 480,
    gatewayId: options.gatewayId?.trim() || DEFAULT_WORKERS_AI_GATEWAY_ID,
  };
}

/**
 * Applies sanitized `CONTOH` AI-drafted text fields onto a plain blueprint draft:
 * - Updates ONLY text fields (`hero`, `about`, `features` text summaries).
 * - Guarantees EVERY drafted field carries the explicit `CONTOH — ` marker.
 * - Guarantees `status: "draft"`, `published: false`, `autoPublished: false`.
 * - Guarantees ALL factual slots (`price`, `licenceNumber`, `reviews`, `phone`, `whatsapp`,
 *   `address`) stay strictly empty / untouched.
 */
export function applyOnboardingAiDraftToBlueprint(
  plainBlueprint: OnboardingBlueprintDraft,
  parsed: OnboardingAiDraftParseSuccess,
): OnboardingBlueprintDraft {
  const plainText = plainBlueprint.textFields;

  const mergedServiceSummaries: readonly OnboardingDraftServiceSummary[] =
    parsed.fields.serviceSummaries && parsed.fields.serviceSummaries.length > 0
      ? parsed.fields.serviceSummaries
      : plainText.serviceSummaries.map((item) => ({
          title: markAsContohDraft(item.title, 80),
          description: markAsContohDraft(item.description, 180),
        }));

  const draftedTextFields: OnboardingAiDraftTextFields = {
    heroEyebrow:
      parsed.fields.heroEyebrow ?? markAsContohDraft(plainText.heroEyebrow, 70),
    heroHeadline: parsed.fields.heroHeadline,
    heroSubheadline:
      parsed.fields.heroSubheadline ?? markAsContohDraft(plainText.heroSubheadline, 240),
    heroCtaLabel:
      parsed.fields.heroCtaLabel ?? markAsContohDraft(plainText.heroCtaLabel, 56),
    aboutHeading:
      parsed.fields.aboutHeading ?? markAsContohDraft(plainText.aboutHeading, 100),
    aboutSummary:
      parsed.fields.aboutSummary ?? markAsContohDraft(plainText.aboutSummary, 420),
    serviceSummaries: mergedServiceSummaries,
  };

  const bp = B2B_VERTICAL_BLUEPRINTS[plainBlueprint.blueprintId];

  // Mutate ONLY text fields on `hero`, `about`, and `features` sections.
  // `offerings`, `testimonials`, and `contact_location` are copied UNCHANGED so facts stay empty!
  const updatedRawSections = plainBlueprint.sections.map((section) => {
    if (section.type === "hero") {
      return {
        ...section,
        config: {
          ...section.config,
          eyebrow: draftedTextFields.heroEyebrow,
          heading: draftedTextFields.heroHeadline,
          subheading: draftedTextFields.heroSubheadline,
          primaryCta: {
            ...section.config.primaryCta,
            label: draftedTextFields.heroCtaLabel,
          },
        },
      };
    }

    if (section.type === "about") {
      return {
        ...section,
        config: {
          ...section.config,
          heading: draftedTextFields.aboutHeading,
          subheading: draftedTextFields.aboutSummary,
          bodyHtml: sanitizeRichTextHtml(
            `<p>${escapeHtml(draftedTextFields.aboutSummary)}</p>`,
          ),
          milestones: [],
        },
      };
    }

    if (section.type === "features") {
      return {
        ...section,
        config: {
          ...section.config,
          items: draftedTextFields.serviceSummaries.map((item, idx) => ({
            title: item.title,
            description: item.description,
            badge: `CONTOH ${idx + 1}`,
          })),
        },
      };
    }

    // All factual / non-text sections stay 100% untouched
    return section;
  });

  const validated = validatePageSections(updatedRawSections, {
    businessCategory: bp.defaultBusinessCategory,
  });
  const sampleSectionIds = computeSampleSectionIds(validated.sections);

  return {
    ...plainBlueprint,
    source: "ai_draft",
    status: "draft",
    published: false,
    autoPublished: false,
    draftMarker: ONBOARDING_AI_DRAFT_MARKER,
    textFields: draftedTextFields,
    facts: EMPTY_ONBOARDING_BLUEPRINT_FACTS,
    sections: validated.sections,
    sampleSectionIds,
  };
}

export { parseAndSanitizeOnboardingAiDraftOutput };
