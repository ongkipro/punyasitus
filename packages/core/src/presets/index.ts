import { z } from "zod";
import type { PublicPageSectionDtoSchema } from "../schemas/public-dto.ts";
import {
  buildGoogleBusinessProfileChecklistStep,
  type GoogleBusinessProfileChecklistStepView,
} from "./gbp-checklist.ts";
import {
  isHealthBusinessCategory,
  SECTION_REGISTRY_SCHEMA_VERSION,
  SectionIdSchema,
  validatePageSections,
  type AnyValidatedPageSection,
  type ClosedSectionType,
  type SectionValidationWarning,
} from "../theme/sections.ts";

type PublicPageSectionDto = z.infer<typeof PublicPageSectionDtoSchema>;

/**
 * Company-Profile Starter Preset & Selective Publication Guardrails
 * (REQ-047, REQ-019, REQ-028, REQ-029, REQ-030, REQ-034, REQ-036; PLAN §11.4; TASK-043).
 *
 * Guarantees:
 * - M1 ships `company_profile` only; `services`, `travel`, and `outlets` are explicitly
 *   deferred to M2 (`TASK-066`) and rejected safely with `422 UNSUPPORTED_PRESET`.
 * - Starter composition uses ONLY the closed unified section registry (`validatePageSections`).
 * - Starter copy is visibly marked as sample content (`[Contoh]` / `[Contoh Draf]`);
 *   zero fabricated reviews, partner logos, licenses, milestones, or availability claims.
 * - Sample claims remain strictly unpublished: publishing selected sections blocks any
 *   selected section that still contains sample markers or unedited sample copy.
 * - Missing optional modules (`services_grid`, `gallery`, `trust_logos`, `testimonials`,
 *   `faq`, custom domain, privacy page) NEVER block first publication; invalid active/selected
 *   sections DO block publication.
 */

export const STARTER_PRESET_IDS = [
  "company_profile",
  "services",
  "travel",
  "outlets",
] as const;
export type StarterPresetId = (typeof STARTER_PRESET_IDS)[number];

export const M1_AVAILABLE_PRESET_IDS = ["company_profile"] as const;
export type M1AvailablePresetId = (typeof M1_AVAILABLE_PRESET_IDS)[number];

export const PRESET_APPLY_MODES = ["preserve_existing", "merge_draft"] as const;
export type PresetApplyMode = (typeof PRESET_APPLY_MODES)[number];

export const STORED_PRESET_APPLY_MODES = [
  "initialized_draft",
  "staged_draft",
  "merged_draft",
] as const;
export type StoredPresetApplyMode = (typeof STORED_PRESET_APPLY_MODES)[number];

export const PRESET_SETUP_STATUSES = ["draft", "published"] as const;
export type PresetSetupStatus = (typeof PRESET_SETUP_STATUSES)[number];

export const PRESET_OPERATION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{3,127}$/;

export const SAMPLE_MARKER_LABEL = "[Contoh]" as const;
export const SAMPLE_DRAFT_MARKER_LABEL = "[Contoh Draf]" as const;

export const COMPANY_PROFILE_CORE_SECTION_IDS = [
  "preset-hero",
  "preset-about",
  "preset-contact",
] as const;

export const COMPANY_PROFILE_OPTIONAL_SECTION_IDS = [
  "preset-services",
  "preset-portfolio",
  "preset-trust-logos",
  "preset-testimonials",
  "preset-faq",
] as const;

const OPTIONAL_SECTION_ID_SET: ReadonlySet<string> = new Set(
  COMPANY_PROFILE_OPTIONAL_SECTION_IDS,
);

// ---------------------------------------------------------------------------
// Preset Catalog (M1: company_profile; M2 TASK-066: services, travel, outlets)
// ---------------------------------------------------------------------------

export interface StarterPresetCatalogEntry {
  readonly id: StarterPresetId;
  readonly name: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly availableInM1: boolean;
  readonly milestone: "M1" | "M2";
  readonly deferredTask: string | null;
  readonly recommendedThemeId: "compro" | "sales" | "travel" | "resto";
  readonly sectionSummary: readonly {
    readonly type: ClosedSectionType;
    readonly label: string;
    readonly optional: boolean;
  }[];
  readonly safetyNote: string;
}

export const STARTER_PRESET_CATALOG: readonly StarterPresetCatalogEntry[] = [
  {
    id: "company_profile",
    name: "Profil Perusahaan (Company Profile)",
    shortDescription:
      "Struktur lengkap untuk profil usaha B2B & korporat: hero, tentang kami, layanan, portofolio, logo mitra, testimoni, FAQ, dan kontak.",
    description:
      "Menyiapkan komposisi draf beranda profil perusahaan beserta daftar periksa kesiapan terbit. Seluruh teks contoh ditandai jelas, tetap berstatus draf, dan tidak pernah menghapus konten yang sudah ada.",
    availableInM1: true,
    milestone: "M1",
    deferredTask: null,
    recommendedThemeId: "compro",
    sectionSummary: [
      { type: "hero", label: "Hero Utama", optional: false },
      { type: "about", label: "Tentang Perusahaan", optional: false },
      { type: "services_grid", label: "Layanan Utama", optional: true },
      { type: "gallery", label: "Portofolio & Dokumentasi", optional: true },
      { type: "trust_logos", label: "Logo Mitra & Kredensial", optional: true },
      { type: "testimonials", label: "Ulasan Klien", optional: true },
      { type: "faq", label: "Pertanyaan Umum (FAQ)", optional: true },
      { type: "contact_location", label: "Kontak & Lokasi", optional: false },
    ],
    safetyNote:
      "Tanpa ulasan palsu, tanpa logo klien fiktif, dan tanpa angka pencapaian buatan. Anda bebas memilih bagian yang sudah divalidasi untuk diterbitkan.",
  },
  {
    id: "services",
    name: "Jasa Profesional & Konsultasi",
    shortDescription:
      "Etalase layanan dengan mode harga transparan, tahapan konsultasi, FAQ, portofolio, dan ajakan konsultasi.",
    description:
      "Preset khusus jasa profesional (REQ-030) dijadwalkan hadir pada rilis M2 (TASK-066).",
    availableInM1: false,
    milestone: "M2",
    deferredTask: "TASK-066",
    recommendedThemeId: "sales",
    sectionSummary: [
      { type: "hero", label: "Hero Layanan", optional: false },
      { type: "services_grid", label: "Paket & Harga Mulai", optional: false },
      { type: "features", label: "Tahapan Konsultasi", optional: true },
      { type: "faq", label: "FAQ Layanan", optional: true },
      { type: "contact_location", label: "Kontak Konsultasi", optional: false },
    ],
    safetyNote: "Segera tersedia pada M2 (TASK-066).",
  },
  {
    id: "travel",
    name: "Agen Travel & Umrah",
    shortDescription:
      "Etalase paket tur, jadwal rencana perjalanan, galeri dokumentasi, FAQ, dan kontak pertanyaan paket.",
    description:
      "Preset khusus travel & Umrah (REQ-028) dijadwalkan hadir pada rilis M2 (TASK-066).",
    availableInM1: false,
    milestone: "M2",
    deferredTask: "TASK-066",
    recommendedThemeId: "travel",
    sectionSummary: [
      { type: "hero", label: "Hero Travel", optional: false },
      { type: "tours_grid", label: "Paket Perjalanan", optional: false },
      { type: "gallery", label: "Galeri Perjalanan", optional: true },
      { type: "faq", label: "FAQ Keberangkatan", optional: true },
      { type: "contact_location", label: "Kontak Agen", optional: false },
    ],
    safetyNote: "Segera tersedia pada M2 (TASK-066).",
  },
  {
    id: "outlets",
    name: "Outlet, Resto & F&B Multi-Cabang",
    shortDescription:
      "Etalase menu/produk, direktori cabang dan jam operasional, galeri tempat, serta petunjuk arah.",
    description:
      "Preset khusus outlet & F&B (REQ-029) dijadwalkan hadir pada rilis M2 (TASK-066).",
    availableInM1: false,
    milestone: "M2",
    deferredTask: "TASK-066",
    recommendedThemeId: "resto",
    sectionSummary: [
      { type: "hero", label: "Hero Outlet", optional: false },
      { type: "products_grid", label: "Menu & Produk", optional: false },
      { type: "branches", label: "Direktori Cabang", optional: true },
      { type: "gallery", label: "Galeri Suasana", optional: true },
      { type: "contact_location", label: "Lokasi & Arah", optional: false },
    ],
    safetyNote: "Segera tersedia pada M2 (TASK-066).",
  },
] as const;

export function getStarterPresetCatalogEntry(
  presetId: string,
): StarterPresetCatalogEntry | null {
  return STARTER_PRESET_CATALOG.find((entry) => entry.id === presetId) ?? null;
}

export function isM1AvailablePresetId(presetId: string): presetId is M1AvailablePresetId {
  return presetId === "company_profile";
}

// ---------------------------------------------------------------------------
// Structured Preset Domain Errors
// ---------------------------------------------------------------------------

export type PresetErrorCode =
  | "UNSUPPORTED_PRESET"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SAMPLE_CONTENT_BLOCKED"
  | "CHECKLIST_INCOMPLETE"
  | "INVALID_SECTION_SELECTION"
  | "PRESET_NOT_INITIALIZED"
  | "VALIDATION_ERROR"
  | "STALE_VERSION";

export interface PresetValidationField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
  readonly sectionId?: string;
}

export class PresetDomainError extends Error {
  readonly httpStatus: 404 | 409 | 422;
  readonly code: PresetErrorCode;
  readonly fields: readonly PresetValidationField[];

  constructor(
    httpStatus: 404 | 409 | 422,
    code: PresetErrorCode,
    message: string,
    fields: readonly PresetValidationField[] = [],
  ) {
    super(message);
    this.name = "PresetDomainError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// Strict Zod v4 Input Schemas (`.strict()` rejects unknown fields)
// ---------------------------------------------------------------------------

export const PresetIdSchema = z.enum(STARTER_PRESET_IDS);
export const PresetApplyModeSchema = z.enum(PRESET_APPLY_MODES);

export const PresetOperationKeySchema = z
  .string()
  .trim()
  .min(4, "operationKey minimal 4 karakter")
  .max(128, "operationKey maksimal 128 karakter")
  .regex(
    PRESET_OPERATION_KEY_RE,
    "operationKey hanya boleh berisi huruf, angka, titik, garis bawah, titik dua, atau tanda hubung",
  );

export const ApplyStarterPresetInputSchema = z
  .object({
    presetId: z.string().trim().min(1).max(64),
    operationKey: PresetOperationKeySchema,
    applyMode: PresetApplyModeSchema.default("preserve_existing"),
  })
  .strict();

export type ApplyStarterPresetInput = z.infer<typeof ApplyStarterPresetInputSchema>;

export const UpdatePresetDraftInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    sections: z.array(z.unknown()).min(1).max(30),
    selectedPublishSectionIds: z.array(SectionIdSchema).max(30).optional(),
  })
  .strict();

export type UpdatePresetDraftInput = z.infer<typeof UpdatePresetDraftInputSchema>;

export const PreviewStarterPresetInputSchema = z
  .object({
    presetId: z.string().trim().min(1).max(64).optional(),
    selectedSectionIds: z.array(SectionIdSchema).max(30).optional(),
  })
  .strict();

export type PreviewStarterPresetInput = z.infer<typeof PreviewStarterPresetInputSchema>;

export const PublishStarterPresetInputSchema = z
  .object({
    presetId: z.string().trim().min(1).max(64),
    selectedSectionIds: z
      .array(SectionIdSchema)
      .min(1, "Pilih minimal satu bagian yang valid untuk diterbitkan")
      .max(30),
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    confirm: z.literal(true, {
      error: "Konfirmasi eksplisit (confirm: true) diperlukan sebelum menerbitkan preset.",
    }),
  })
  .strict();

export type PublishStarterPresetInput = z.infer<typeof PublishStarterPresetInputSchema>;

// ---------------------------------------------------------------------------
// Deterministic Request Hash for Idempotency Conflict Detection
// ---------------------------------------------------------------------------

/**
 * Pure deterministic canonical hash for idempotency payload comparison
 * (works synchronously in Node & Cloudflare `workerd` without external deps).
 */
export function computePresetOperationHash(input: {
  readonly presetId: string;
  readonly applyMode: PresetApplyMode;
}): string {
  const canonical = JSON.stringify({
    presetId: input.presetId.trim(),
    applyMode: input.applyMode,
  });
  let h1 = 0xdeadbeef ^ canonical.length;
  let h2 = 0x41c6ce57 ^ canonical.length;
  for (let i = 0; i < canonical.length; i += 1) {
    const ch = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined =
    (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  return `v1:${input.presetId.trim()}:${input.applyMode}:${combined}`;
}

// ---------------------------------------------------------------------------
// Sample-Claim Detection (Prevents Publishing Unedited Examples / Fake Claims)
// ---------------------------------------------------------------------------

const SAMPLE_TEXT_PATTERNS: readonly { readonly code: string; readonly re: RegExp; readonly label: string }[] = [
  {
    code: "SAMPLE_MARKER_TAG",
    re: /\[contoh(?:\s+draf)?\]/i,
    label: "Masih mengandung penanda [Contoh]",
  },
  {
    code: "SAMPLE_COPY_PHRASE",
    re: /\bcontoh\s*[—:-]\s*/i,
    label: "Masih mengandung teks contoh yang belum diubah",
  },
  {
    code: "LOREM_IPSUM",
    re: /\blorem\s+ipsum\b/i,
    label: "Mengandung teks placeholder Lorem Ipsum",
  },
  {
    code: "PLACEHOLDER_CONTACT",
    re: /(?:0812-?0000-?0000|contoh@domain\.id|pt\s+contoh\s+nusantara|nama\s+klien\s+contoh)/i,
    label: "Mengandung data kontak atau nama contoh",
  },
  {
    code: "SAMPLE_GUIDANCE_PROMPT",
    re: /(?:ubah\s+sebelum\s+diterbitkan|ganti\s+dengan\s+informasi\s+resmi)/i,
    label: "Masih mengandung panduan pengisian draf",
  },
];

export interface SampleClaimFinding {
  readonly sectionId: string;
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function scanValueForSamplePatterns(
  value: unknown,
  sectionId: string,
  fieldPath: string,
  findings: SampleClaimFinding[],
): void {
  if (typeof value === "string") {
    const cleaned = stripHtmlTags(value);
    for (const pattern of SAMPLE_TEXT_PATTERNS) {
      if (pattern.re.test(cleaned)) {
        findings.push({
          sectionId,
          field: fieldPath,
          code: pattern.code,
          message: `${pattern.label} pada ${fieldPath}.`,
        });
        break;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanValueForSamplePatterns(value[i], sectionId, `${fieldPath}[${i}]`, findings);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanValueForSamplePatterns(v, sectionId, `${fieldPath}.${k}`, findings);
    }
  }
}

/**
 * Inspects a validated section for visible sample markers, placeholder copy, or
 * unedited starter prompts so sample claims NEVER leak to the published site.
 */
export function detectSampleClaimsInSection(
  section: AnyValidatedPageSection,
): readonly SampleClaimFinding[] {
  const findings: SampleClaimFinding[] = [];
  scanValueForSamplePatterns(section.config, section.id, `sections.${section.id}.config`, findings);
  return findings;
}

export function computeSampleSectionIds(
  sections: readonly AnyValidatedPageSection[],
): readonly string[] {
  const result: string[] = [];
  for (const section of sections) {
    if (detectSampleClaimsInSection(section).length > 0) {
      result.push(section.id);
    }
  }
  return result;
}

/**
 * Forces every section containing sample markers to `enabled: false` before
 * mirroring into `pages.draft_sections_json`, guaranteeing that generic page
 * publish flows (TASK-034/TASK-036) can NEVER accidentally publish sample copy.
 */
export function disableSampleSectionsForPageDraft(
  sections: readonly AnyValidatedPageSection[],
): readonly AnyValidatedPageSection[] {
  return sections.map((section) =>
    detectSampleClaimsInSection(section).length > 0
      ? ({ ...section, enabled: false } as AnyValidatedPageSection)
      : section,
  );
}

/**
 * Non-destructively merges missing starter section slots onto an existing preset
 * draft without overwriting user-edited sections, order, or singleton `hero`.
 */
export function mergeStarterPresetDraftSections(
  existingSections: readonly AnyValidatedPageSection[],
  starterSections: readonly AnyValidatedPageSection[],
  businessCategory?: string | null,
): readonly AnyValidatedPageSection[] {
  if (existingSections.length === 0) {
    return starterSections;
  }
  const existingIds = new Set(existingSections.map((s) => s.id));
  const existingTypes = new Set(existingSections.map((s) => s.type));
  const hasHero = existingTypes.has("hero");

  const missingStarter = starterSections.filter((s) => {
    if (existingIds.has(s.id) || existingTypes.has(s.type)) return false;
    if (s.type === "hero" && hasHero) return false;
    return true;
  });

  if (missingStarter.length === 0) {
    return existingSections;
  }

  const combined = [...existingSections, ...missingStarter].map((s, idx) => ({
    id: s.id,
    type: s.type,
    schemaVersion: s.schemaVersion,
    enabled: s.enabled,
    order: idx,
    config: s.config,
  }));

  return validatePageSections(combined, { businessCategory }).sections;
}

/**
 * Non-destructively merges newly published preset `PublicPageSectionDto` items
 * onto an existing live homepage's published sections:
 * - Preserves 100% of existing non-preset live sections in their original order.
 * - Updates matching preset section IDs in place.
 * - Never creates a duplicate singleton `hero` when a user-authored live hero already exists.
 */
export function mergePublishedPageSectionsNonDestructively(
  existingPublishedSections: readonly PublicPageSectionDto[],
  incomingPresetSections: readonly PublicPageSectionDto[],
): readonly PublicPageSectionDto[] {
  if (existingPublishedSections.length === 0) {
    return [...incomingPresetSections];
  }

  const incomingById = new Map<string, PublicPageSectionDto>();
  for (const s of incomingPresetSections) {
    incomingById.set(s.id, s);
  }

  const placedIds = new Set<string>();
  const result: PublicPageSectionDto[] = [];

  for (const existing of existingPublishedSections) {
    const replacement = incomingById.get(existing.id);
    if (replacement) {
      result.push(replacement);
      placedIds.add(existing.id);
    } else {
      result.push(existing);
    }
  }

  const alreadyHasHero = result.some((s) => s.kind === "hero");

  for (const incoming of incomingPresetSections) {
    if (placedIds.has(incoming.id)) continue;
    if (incoming.kind === "hero" && alreadyHasHero) {
      // Preserve the tenant's existing live hero without duplicating the singleton hero landmark
      continue;
    }
    result.push(incoming);
    placedIds.add(incoming.id);
  }

  return result;
}

export function isOptionalCompanyProfileSection(sectionId: string): boolean {
  return OPTIONAL_SECTION_ID_SET.has(sectionId);
}

// ---------------------------------------------------------------------------
// Company-Profile Starter Composition Builder (M1, REQ-047)
// ---------------------------------------------------------------------------

export interface CompanyProfileStarterSeedContext {
  readonly businessName: string;
  readonly businessCategory?: string | null;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly whatsappPhone?: string | null;
  readonly email?: string | null;
}

export interface BuiltStarterComposition {
  readonly presetId: M1AvailablePresetId;
  readonly sections: readonly AnyValidatedPageSection[];
  readonly sampleSectionIds: readonly string[];
  readonly optionalSectionIds: readonly string[];
  readonly defaultSelectedPublishSectionIds: readonly string[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly isHealthCategory: boolean;
}

/**
 * Builds the validated Company-Profile starter draft composition (PLAN §11.4):
 * hero, about, services, portfolio (gallery), trust logos, testimonials, FAQ, and contact.
 *
 * Strictly enforces:
 * - Zero fabricated reviews (`testimonials.items = []`)
 * - Zero fabricated partner logos or licenses (`trust_logos.items = []`)
 * - Zero fabricated milestones or numbers (`about.milestones = []`)
 * - Zero fabricated portfolio photos (`gallery.items = []`)
 * - Zero fabricated offerings/prices (`services_grid.items = []`)
 * - Visibly marked sample draft copy (`[Contoh]` / `[Contoh Draf]`) on text prompts
 * - Permenkes health-category default-off + warning on `testimonials`
 */
export function buildCompanyProfileStarterComposition(
  ctx: CompanyProfileStarterSeedContext,
): BuiltStarterComposition {
  const cleanName = ctx.businessName.trim() || "Perusahaan Anda";
  const businessCategory = ctx.businessCategory?.trim() || "LocalBusiness";
  const hasRealContact = Boolean(
    ctx.address?.trim() || ctx.phone?.trim() || ctx.whatsappPhone?.trim() || ctx.email?.trim(),
  );

  const rawSections: unknown[] = [
    {
      id: "preset-hero",
      type: "hero",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: `${SAMPLE_MARKER_LABEL} Profil Perusahaan`,
        heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Mitra Profesional Bisnis Anda`,
        subheading:
          "Contoh — ubah sebelum diterbitkan: jelaskan layanan utama, cakupan wilayah, dan nilai tambah perusahaan Anda secara ringkas.",
        primaryCta: {
          label: "Hubungi Tim Kami",
          href: "#kontak",
          variant: "primary",
        },
        secondaryCta: {
          label: "Lihat Layanan",
          href: "/layanan",
          variant: "secondary",
        },
        highlights: [],
      },
    },
    {
      id: "preset-about",
      type: "about",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Tentang Perusahaan",
        heading: `${SAMPLE_DRAFT_MARKER_LABEL} Mengenal ${cleanName}`,
        subheading:
          "Contoh — ganti dengan informasi resmi mengenai sejarah singkat, fokus layanan, dan komitmen perusahaan.",
        bodyHtml:
          "<p>[Contoh Draf] Tuliskan profil singkat perusahaan Anda secara faktual. Hindari angka pencapaian atau klaim sertifikasi yang belum diverifikasi.</p>",
        milestones: [],
      },
    },
    {
      id: "preset-services",
      type: "services_grid",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Layanan",
        heading: "Layanan Utama Kami",
        subheading:
          "Daftar layanan yang Anda tambahkan pada menu Katalog akan tampil otomatis di bagian ini.",
        offeringType: "service",
        limit: 6,
        itemSlugs: [],
        items: [],
        emptyMessage: "Belum ada layanan terbit. Tambahkan layanan melalui menu Katalog.",
        viewAllCta: {
          label: "Lihat Semua Layanan",
          href: "/layanan",
          variant: "secondary",
        },
      },
    },
    {
      id: "preset-portfolio",
      type: "gallery",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "Portofolio",
        heading: "Dokumentasi & Portofolio Proyek",
        subheading:
          "Unggah dokumentasi proyek asli perusahaan Anda melalui Media sebelum mengaktifkan bagian ini.",
        columns: 3,
        items: [],
      },
    },
    {
      id: "preset-trust-logos",
      type: "trust_logos",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "Kepercayaan",
        heading: "Mitra & Kredensial Resmi",
        subheading:
          "Tambahkan logo klien atau kredensial resmi yang telah disetujui secara tertulis (opsional).",
        columns: 4,
        items: [],
      },
    },
    {
      id: "preset-testimonials",
      type: "testimonials",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      // Omit `enabled` on health categories so `validatePageSections` records `defaultedOff: true` + Permenkes warning;
      // on non-health categories keep disabled by default until owner adds real reviews!
      ...(isHealthBusinessCategory(businessCategory) ? {} : { enabled: false }),
      config: {
        eyebrow: "Testimoni",
        heading: "Ulasan Klien",
        subheading:
          "Tambahkan ulasan asli dari klien Anda. Preset tidak pernah mengisi testimoni fiktif.",
        items: [],
      },
    },
    {
      id: "preset-faq",
      type: "faq",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "FAQ",
        heading: `${SAMPLE_MARKER_LABEL} Pertanyaan yang Sering Diajukan`,
        subheading:
          "Contoh — ubah sebelum diterbitkan agar sesuai dengan prosedur layanan perusahaan Anda.",
        items: [
          {
            question: `${SAMPLE_MARKER_LABEL} Bagaimana cara memulai konsultasi dengan tim kami?`,
            answer:
              "Contoh — ubah sebelum diterbitkan: jelaskan alur konsultasi, jam operasional, dan estimasi waktu respons tim Anda.",
            defaultOpen: false,
          },
        ],
      },
    },
    {
      id: "preset-contact",
      type: "contact_location",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Kontak",
        heading: `Hubungi ${cleanName}`,
        subheading: hasRealContact
          ? "Hubungi tim kami untuk diskusi kebutuhan bisnis atau permintaan penawaran."
          : "Contoh — ubah sebelum diterbitkan: lengkapi alamat kantor, nomor WhatsApp, dan email bisnis Anda di Pengaturan.",
        ...(ctx.address?.trim() ? { address: ctx.address.trim() } : {}),
        ...(ctx.phone?.trim() ? { phone: ctx.phone.trim() } : {}),
        ...(ctx.whatsappPhone?.trim() ? { whatsappPhone: ctx.whatsappPhone.trim() } : {}),
        ...(ctx.email?.trim() ? { email: ctx.email.trim() } : {}),
        branches: [],
      },
    },
  ];

  const validated = validatePageSections(rawSections, { businessCategory });
  const sampleSectionIds = computeSampleSectionIds(validated.sections);

  return {
    presetId: "company_profile",
    sections: validated.sections,
    sampleSectionIds,
    optionalSectionIds: [...COMPANY_PROFILE_OPTIONAL_SECTION_IDS],
    defaultSelectedPublishSectionIds: validated.sections
      .filter((s) => s.enabled)
      .map((s) => s.id),
    warnings: validated.warnings,
    isHealthCategory: validated.isHealthCategory,
  };
}

// ---------------------------------------------------------------------------
// Selective Publication Guard (Blocks Sample Claims & Invalid Sections Only)
// ---------------------------------------------------------------------------

export interface ValidateSelectivePublishParams {
  readonly presetId: string;
  readonly draftSections: readonly AnyValidatedPageSection[];
  readonly selectedSectionIds: readonly string[];
  readonly businessCategory?: string | null;
}

export interface ValidatedSelectivePublishResult {
  readonly selectedSections: readonly AnyValidatedPageSection[];
  readonly unpublishedDraftSectionIds: readonly string[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly missingOptionalSectionIds: readonly string[];
}

/**
 * Validates that ONLY valid, non-sample selected sections are published:
 * - Rejects unknown/unsupported preset IDs (`422 UNSUPPORTED_PRESET`).
 * - Rejects empty, duplicate, or unknown section IDs (`422 INVALID_SECTION_SELECTION`).
 * - Re-validates every selected section through `validatePageSections` (unsupported types,
 *   unsafe URLs, duplicate singletons, or invalid configs fail safely with `422`).
 * - Blocks publication if ANY selected section still contains sample markers or unedited
 *   sample copy (`422 SAMPLE_CONTENT_BLOCKED`).
 * - Missing optional modules NEVER block first publication.
 */
export function validatePresetSelectivePublish(
  params: ValidateSelectivePublishParams,
): ValidatedSelectivePublishResult {
  if (!isM1AvailablePresetId(params.presetId)) {
    throw new PresetDomainError(
      422,
      "UNSUPPORTED_PRESET",
      `Preset "${params.presetId}" belum tersedia pada M1. Saat ini hanya preset company_profile yang dapat diterbitkan.`,
      [
        {
          field: "presetId",
          code: "UNSUPPORTED_PRESET",
          message: `Preset "${params.presetId}" is not available in M1 (deferred to M2 TASK-066)`,
        },
      ],
    );
  }

  if (params.selectedSectionIds.length === 0) {
    throw new PresetDomainError(
      422,
      "INVALID_SECTION_SELECTION",
      "Pilih minimal satu bagian yang sudah divalidasi untuk diterbitkan.",
      [
        {
          field: "selectedSectionIds",
          code: "EMPTY_SELECTION",
          message: "At least one section must be selected for publication",
        },
      ],
    );
  }

  const byId = new Map<string, AnyValidatedPageSection>();
  for (const section of params.draftSections) {
    byId.set(section.id, section);
  }

  const selectedSet = new Set<string>();
  const duplicateFields: PresetValidationField[] = [];
  const unknownFields: PresetValidationField[] = [];

  for (const id of params.selectedSectionIds) {
    if (selectedSet.has(id)) {
      duplicateFields.push({
        field: "selectedSectionIds",
        code: "DUPLICATE_SECTION_SELECTION",
        message: `Bagian "${id}" dipilih lebih dari satu kali.`,
        sectionId: id,
      });
      continue;
    }
    if (!byId.has(id)) {
      unknownFields.push({
        field: "selectedSectionIds",
        code: "UNKNOWN_SECTION_ID",
        message: `Bagian "${id}" tidak ditemukan dalam komposisi draf preset.`,
        sectionId: id,
      });
      continue;
    }
    selectedSet.add(id);
  }

  if (duplicateFields.length > 0 || unknownFields.length > 0) {
    throw new PresetDomainError(
      422,
      "INVALID_SECTION_SELECTION",
      "Daftar bagian terpilih tidak valid.",
      [...duplicateFields, ...unknownFields],
    );
  }

  // Preserve the draft's deterministic section order and force selected sections `enabled: true`
  const orderedSelectedInputs = params.draftSections
    .filter((section) => selectedSet.has(section.id))
    .map((section, idx) => ({
      id: section.id,
      type: section.type,
      schemaVersion: section.schemaVersion,
      enabled: true,
      order: idx,
      config: section.config,
    }));

  // Strict closed-registry validation (throws SectionRegistryValidationError on invalid/unsupported)
  const validated = validatePageSections(orderedSelectedInputs, {
    businessCategory: params.businessCategory,
  });

  // Sample-claim guardrail: NEVER publish unedited sample markers/claims!
  const sampleFields: PresetValidationField[] = [];
  for (const section of validated.sections) {
    const findings = detectSampleClaimsInSection(section);
    for (const f of findings) {
      sampleFields.push({
        field: f.field,
        code: f.code,
        message: f.message,
        sectionId: f.sectionId,
      });
    }
  }

  if (sampleFields.length > 0) {
    const uniqueIds = Array.from(new Set(sampleFields.map((f) => f.sectionId).filter(Boolean)));
    throw new PresetDomainError(
      422,
      "SAMPLE_CONTENT_BLOCKED",
      `Teks contoh belum boleh diterbitkan (${uniqueIds.join(", ")}). Ubah teks contoh dengan data asli usaha Anda atau batal pilih bagian tersebut sebelum menerbitkan.`,
      sampleFields,
    );
  }

  const unpublishedDraftSectionIds = params.draftSections
    .filter((s) => !selectedSet.has(s.id))
    .map((s) => s.id);

  const missingOptionalSectionIds = COMPANY_PROFILE_OPTIONAL_SECTION_IDS.filter(
    (id) => !selectedSet.has(id),
  );

  return {
    selectedSections: validated.sections,
    unpublishedDraftSectionIds,
    warnings: validated.warnings,
    missingOptionalSectionIds,
  };
}

// ---------------------------------------------------------------------------
// Checklist Evaluator (PLAN §11.4: identity, first page/catalog, contact/WA,
// privacy, preview, domain readiness)
// ---------------------------------------------------------------------------

export type PresetChecklistItemId =
  | "identity"
  | "first_content"
  | "contact_wa"
  | "privacy"
  | "preview"
  | "domain"
  | "google_business_profile";

export type PresetChecklistItemStatus = "done" | "pending" | "optional_pending";

export interface PresetChecklistItem {
  readonly id: PresetChecklistItemId;
  readonly label: string;
  readonly description: string;
  readonly status: PresetChecklistItemStatus;
  readonly requiredForPublish: boolean;
  readonly detail: string;
  readonly actionLabel: string;
  readonly actionHref: string;
  readonly officialHelpUrl?: string;
  readonly helpArticleHref?: string;
}

export interface PresetChecklistFacts {
  readonly handle: string;
  readonly siteTitle: string | null;
  readonly businessName: string | null;
  readonly hasCustomizedDraftSection: boolean;
  readonly nonTrashedPagesCount: number;
  readonly nonTrashedOfferingsCount: number;
  readonly whatsappE164: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly hasPrivacyPage: boolean;
  readonly hasPreviewedPreset: boolean;
  readonly activeCustomHostname: string | null;
  readonly fallbackHost: string;
  /** Optional TASK-073 / REQ-074 facts: when provided (or `includeGoogleBusinessProfileStep: true`), appends the GBP onboarding step. */
  readonly googleMapsReviewUrl?: string | null;
  readonly hasPublishedGoogleMapsReviewUrl?: boolean;
  readonly includeGoogleBusinessProfileStep?: boolean;
}

export interface PresetChecklistSummary {
  readonly items: readonly PresetChecklistItem[];
  readonly completedCount: number;
  readonly totalCount: number;
  readonly requiredCompletedCount: number;
  readonly requiredTotalCount: number;
  readonly readyForFirstPublish: boolean;
}

function isNonSampleName(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  return !SAMPLE_TEXT_PATTERNS.some((p) => p.re.test(trimmed));
}

export function evaluatePresetChecklist(facts: PresetChecklistFacts): PresetChecklistSummary {
  const base = `/dashboard/${encodeURIComponent(facts.handle)}`;

  const identityDone = isNonSampleName(facts.siteTitle) && isNonSampleName(facts.businessName);
  const firstContentDone =
    facts.hasCustomizedDraftSection ||
    facts.nonTrashedOfferingsCount > 0 ||
    facts.nonTrashedPagesCount > 1;
  const contactDone = Boolean(
    facts.whatsappE164?.trim() || facts.phone?.trim() || facts.email?.trim(),
  );
  const privacyDone = facts.hasPrivacyPage;
  const previewDone = facts.hasPreviewedPreset;
  const domainDone = Boolean(facts.activeCustomHostname);

  const items: readonly PresetChecklistItem[] = [
    {
      id: "identity",
      label: "Identitas Situs & Usaha",
      description: "Pastikan nama situs dan nama usaha resmi sudah diisi dengan benar.",
      status: identityDone ? "done" : "pending",
      requiredForPublish: true,
      detail: identityDone
        ? `${facts.businessName?.trim()} (${facts.siteTitle?.trim()})`
        : "Lengkapi nama situs dan nama usaha di Pengaturan Umum.",
      actionLabel: "Buka Pengaturan",
      actionHref: `${base}/settings`,
    },
    {
      id: "first_content",
      label: "Halaman Utama atau Item Katalog Pertama",
      description:
        "Sesuaikan minimal satu bagian beranda dengan info asli usaha Anda atau tambahkan item katalog.",
      status: firstContentDone ? "done" : "pending",
      requiredForPublish: true,
      detail: firstContentDone
        ? `${facts.nonTrashedPagesCount} halaman, ${facts.nonTrashedOfferingsCount} item katalog`
        : "Ubah teks [Contoh] pada draf beranda atau buat item layanan pertama.",
      actionLabel: "Kelola Katalog",
      actionHref: `${base}/catalog`,
    },
    {
      id: "contact_wa",
      label: "Kontak & WhatsApp Bisnis",
      description: "Siapkan nomor WhatsApp, telepon, atau email bisnis agar calon klien mudah menghubungi.",
      status: contactDone ? "done" : "optional_pending",
      requiredForPublish: false,
      detail: contactDone
        ? [facts.whatsappE164, facts.phone, facts.email].filter(Boolean).join(" · ")
        : "Opsional saat terbit awal — disarankan melengkapi WhatsApp bisnis.",
      actionLabel: "Atur Kontak",
      actionHref: `${base}/settings`,
    },
    {
      id: "privacy",
      label: "Halaman Kebijakan Privasi",
      description: "Tambahkan atau tautkan halaman kebijakan privasi bila mengumpulkan data prospek.",
      status: privacyDone ? "done" : "optional_pending",
      requiredForPublish: false,
      detail: privacyDone
        ? "Halaman kebijakan privasi sudah tersedia."
        : "Opsional — tidak menghalangi penerbitan awal profil perusahaan.",
      actionLabel: "Kelola Halaman",
      actionHref: `${base}/pages`,
    },
    {
      id: "preview",
      label: "Pratinjau Draf Responsif",
      description: "Periksa tampilan draf pada layar desktop dan seluler sebelum diterbitkan.",
      status: previewDone ? "done" : "optional_pending",
      requiredForPublish: false,
      detail: previewDone
        ? "Pratinjau draf sudah diperiksa."
        : "Klik tombol Pratinjau Draf di halaman ini untuk memeriksa hasil sebelum terbit.",
      actionLabel: "Buka Pratinjau",
      actionHref: `${base}/onboarding#pratinjau`,
    },
    {
      id: "domain",
      label: "Kesiapan Domain Publik",
      description: "Situs dapat langsung tayang di subdomain gratis atau dihubungkan ke domain kustom.",
      status: domainDone ? "done" : "optional_pending",
      requiredForPublish: false,
      detail: domainDone
        ? `Domain kustom aktif: ${facts.activeCustomHostname}`
        : `Siap tayang di ${facts.fallbackHost} (domain kustom opsional).`,
      actionLabel: "Atur Domain",
      actionHref: `${base}/settings/domains`,
    },
  ];

  const includeGbpStep =
    facts.includeGoogleBusinessProfileStep === true ||
    facts.googleMapsReviewUrl !== undefined;

  const finalItems: readonly PresetChecklistItem[] = includeGbpStep
    ? [
        ...items,
        (() => {
          const gbp: GoogleBusinessProfileChecklistStepView =
            buildGoogleBusinessProfileChecklistStep({
              handle: facts.handle,
              publicSiteHref: `https://${facts.activeCustomHostname ?? facts.fallbackHost}`,
              googleMapsReviewUrl: facts.googleMapsReviewUrl ?? null,
              hasPublishedReviewUrl: facts.hasPublishedGoogleMapsReviewUrl,
            });
          return {
            id: gbp.id,
            label: gbp.label,
            description: gbp.description,
            status: gbp.status,
            requiredForPublish: false,
            detail: gbp.detail,
            actionLabel: gbp.actionLabel,
            actionHref: gbp.actionHref,
            officialHelpUrl: gbp.officialHelpUrl,
            helpArticleHref: gbp.helpArticleHref,
          };
        })(),
      ]
    : items;

  const completedCount = finalItems.filter((item) => item.status === "done").length;
  const requiredItems = finalItems.filter((item) => item.requiredForPublish);
  const requiredCompletedCount = requiredItems.filter((item) => item.status === "done").length;

  return {
    items: finalItems,
    completedCount,
    totalCount: finalItems.length,
    requiredCompletedCount,
    requiredTotalCount: requiredItems.length,
    readyForFirstPublish: requiredCompletedCount === requiredItems.length,
  };
}

// ---------------------------------------------------------------------------
// Conversion to PublicPageSectionDto (Compatible with TASK-005 / TASK-034 / TASK-036)
// ---------------------------------------------------------------------------

function mapClosedTypeToPublicSectionKind(
  type: ClosedSectionType,
): PublicPageSectionDto["kind"] {
  switch (type) {
    case "hero":
      return "hero";
    case "about":
      return "about";
    case "rich_text":
      return "rich_text";
    case "services_grid":
    case "offerings_grid":
      return "services_grid";
    case "products_grid":
      return "products_grid";
    case "tours_grid":
      return "tours_grid";
    case "vehicles_grid":
      return "vehicles_grid";
    case "gallery":
      return "gallery";
    case "trust_logos":
    case "features":
    case "highlights":
      return "trust_logos";
    case "team":
      return "team";
    case "testimonials":
      return "testimonials";
    case "faq":
      return "faq";
    case "blog_latest":
    case "latest_posts":
      return "latest_posts";
    case "cta_banner":
    case "cta_band":
      return "cta_band";
    case "custom_form":
      return "custom_form";
    case "contact_location":
    case "contact":
      return "contact";
    case "branches":
      return "branches";
  }
}

function escapeBasicHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Converts validated `AnyValidatedPageSection` entries into strict
 * `PublicPageSectionDto` items accepted by `PageSnapshotSchema` (`TASK-005`/`TASK-036`).
 */
export function convertValidatedSectionToPublicPageSectionDto(
  section: AnyValidatedPageSection,
): PublicPageSectionDto {
  const kind = mapClosedTypeToPublicSectionKind(section.type);
  const cfg = section.config as Record<string, unknown>;
  const heading = typeof cfg.heading === "string" ? cfg.heading : null;
  const subheading = typeof cfg.subheading === "string" ? cfg.subheading : null;

  let bodyHtml: string | null = null;
  let ctaLabel: string | null = null;
  let ctaHref: string | null = null;
  let itemSlugs: string[] | undefined;

  if (section.type === "hero") {
    ctaLabel = section.config.primaryCta?.label ?? null;
    ctaHref = section.config.primaryCta?.href ?? null;
  } else if (section.type === "about" || section.type === "rich_text") {
    bodyHtml = section.config.bodyHtml || null;
    ctaLabel = section.config.cta?.label ?? null;
    ctaHref = section.config.cta?.href ?? null;
  } else if (
    section.type === "services_grid" ||
    section.type === "offerings_grid" ||
    section.type === "products_grid" ||
    section.type === "tours_grid" ||
    section.type === "vehicles_grid"
  ) {
    itemSlugs = [...section.config.itemSlugs];
    ctaLabel = section.config.viewAllCta?.label ?? null;
    ctaHref = section.config.viewAllCta?.href ?? null;
  } else if (section.type === "faq") {
    if (section.config.items.length > 0) {
      bodyHtml = section.config.items
        .map(
          (item) =>
            `<details><summary>${escapeBasicHtml(item.question)}</summary><p>${escapeBasicHtml(item.answer)}</p></details>`,
        )
        .join("");
    }
  } else if (section.type === "testimonials") {
    if (section.config.items.length > 0) {
      bodyHtml = section.config.items
        .map(
          (item) =>
            `<blockquote><p>${escapeBasicHtml(item.quote)}</p><footer>${escapeBasicHtml(item.authorName)}</footer></blockquote>`,
        )
        .join("");
    }
  } else if (
    section.type === "contact_location" ||
    section.type === "contact" ||
    section.type === "branches"
  ) {
    const parts: string[] = [];
    if (section.config.address) parts.push(`<p>${escapeBasicHtml(section.config.address)}</p>`);
    if (section.config.phone) parts.push(`<p>Telepon: ${escapeBasicHtml(section.config.phone)}</p>`);
    if (section.config.email) parts.push(`<p>Email: ${escapeBasicHtml(section.config.email)}</p>`);
    if (parts.length > 0) bodyHtml = parts.join("");
  } else if (
    section.type === "cta_banner" ||
    section.type === "cta_band" ||
    section.type === "custom_form"
  ) {
    ctaLabel = section.config.primaryCta.label;
    ctaHref = section.config.primaryCta.href;
  }

  return {
    id: section.id,
    kind,
    heading,
    subheading,
    bodyHtml,
    ...(ctaLabel ? { ctaLabel } : {}),
    ...(ctaHref ? { ctaHref } : {}),
    ...(itemSlugs && itemSlugs.length > 0 ? { itemSlugs } : {}),
  };
}

export * from "./blueprints.ts";
export * from "./checklist.ts";
export * from "./gbp-checklist.ts";
