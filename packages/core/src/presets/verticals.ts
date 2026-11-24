import { z } from "zod";
import {
  SERVICE_PRICING_MODE_LABELS,
  SERVICE_PRICING_MODES,
  ServiceConsultationAttributesSchema,
  validateServiceConsultationAttributes,
  type ServiceConsultationAttributes,
  type ServicePricingMode,
} from "../catalog/service.ts";
import {
  canPublishTravelPackage,
  TravelPackageAttributesSchema,
  UMRAH_COUNSEL_GATE_REQUIRED,
  UMRAH_LICENSE_REQUIRED,
  UMRAH_OPERATOR_VERIFICATION_REQUIRED,
  validateTravelPackageAttributes,
  type TravelPackageAttributes,
} from "../catalog/travel.ts";
import {
  SECTION_REGISTRY_SCHEMA_VERSION,
  validatePageSections,
  type AnyValidatedPageSection,
  type ClosedSectionType,
  type SectionValidationWarning,
} from "../theme/sections.ts";
import {
  buildGoogleBusinessProfileChecklistStep,
  GBP_CHECKLIST_STEP_ID,
  GBP_OFFICIAL_HELP_URLS,
} from "./gbp-checklist.ts";
import {
  buildCompanyProfileStarterComposition,
  computePresetOperationHash,
  computeSampleSectionIds,
  detectSampleClaimsInSection,
  evaluatePresetChecklist,
  PresetDomainError,
  SAMPLE_DRAFT_MARKER_LABEL,
  SAMPLE_MARKER_LABEL,
  type CompanyProfileStarterSeedContext,
  type PresetApplyMode,
  type PresetChecklistItem,
  type PresetChecklistSummary,
  type PresetValidationField,
  type StarterPresetId,
} from "./index.ts";

/**
 * M2 Additional Vertical Starter Presets (`packages/core/src/presets/verticals.ts`;
 * TASK-066, REQ-047, REQ-028, REQ-029, REQ-030, DEC-042; PLAN §11.4).
 *
 * Adds three M2 vertical starter presets alongside M1 `company_profile` without
 * breaking any M1 `tests/task-043/` or `tests/task-073/` contract:
 * 1. `professional_services` (Layanan Profesional — TASK-035)
 * 2. `travel_umrah` (Travel & Wisata / Umrah — TASK-020, DEC-042)
 * 3. `multi_outlet` (Usaha Multi-Gerai / Offline — TASK-019 + TASK-073 GBP)
 *
 * Hard Invariants:
 * - Every seeded page, offering, and outlet template is STRICTLY `draft` (`status: "draft"`,
 *   zero auto-publish, zero published snapshots, zero `cache_version` publish bumps).
 * - Every sample copy string carries explicit `CONTOH` placeholder wording (`SAMPLE_COPY_PHRASE`),
 *   ZERO fabricated prices, permits/licenses, reviews/testimonials/ratings, addresses,
 *   coordinates, operating hours, or phone numbers.
 * - `travel_umrah` seeds ONLY `packageKind: "general_tour"` and explicitly surfaces DEC-042
 *   `SK PPIU` + operator verification + counsel approval gate guidance (NEVER auto-publishes Umrah).
 */

export const SAMPLE_COPY_PHRASE = "CONTOH" as const;

export const M2_VERTICAL_PRESET_IDS = [
  "professional_services",
  "travel_umrah",
  "multi_outlet",
] as const;
export type M2VerticalPresetId = (typeof M2_VERTICAL_PRESET_IDS)[number];

export const ALL_VERTICAL_PRESET_IDS = [
  "company_profile",
  "professional_services",
  "travel_umrah",
  "multi_outlet",
] as const;
export type VerticalStarterPresetId = (typeof ALL_VERTICAL_PRESET_IDS)[number];

const CANONICAL_TO_STORAGE_PRESET_ID: Readonly<Record<VerticalStarterPresetId, StarterPresetId>> = {
  company_profile: "company_profile",
  professional_services: "services",
  travel_umrah: "travel",
  multi_outlet: "outlets",
};

const STORAGE_OR_ALIAS_TO_CANONICAL: Readonly<Record<string, VerticalStarterPresetId>> = {
  company_profile: "company_profile",
  professional_services: "professional_services",
  services: "professional_services",
  travel_umrah: "travel_umrah",
  travel: "travel_umrah",
  multi_outlet: "multi_outlet",
  outlets: "multi_outlet",
};

export function isVerticalStarterPresetId(value: string): value is VerticalStarterPresetId {
  return (ALL_VERTICAL_PRESET_IDS as readonly string[]).includes(value);
}

export function isM2VerticalPresetId(value: string): value is M2VerticalPresetId {
  return (M2_VERTICAL_PRESET_IDS as readonly string[]).includes(value);
}

/**
 * Resolves either a canonical M2 vertical preset ID (`professional_services`,
 * `travel_umrah`, `multi_outlet`, `company_profile`) or its compact storage alias
 * (`services`, `travel`, `outlets`) to the canonical `VerticalStarterPresetId`.
 */
export function resolveCanonicalVerticalPresetId(
  raw: string | null | undefined,
): VerticalStarterPresetId | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  return STORAGE_OR_ALIAS_TO_CANONICAL[key] ?? null;
}

/**
 * Maps canonical vertical preset IDs onto the existing `preset_setups.preset_id`
 * SQLite CHECK enum (`company_profile` | `services` | `travel` | `outlets`)
 * so zero new SQL migrations are needed.
 */
export function toStorageStarterPresetId(presetId: VerticalStarterPresetId): StarterPresetId {
  return CANONICAL_TO_STORAGE_PRESET_ID[presetId];
}

// ---------------------------------------------------------------------------
// Vertical Preset Catalog Metadata (4 Verticals: M1 + 3 M2)
// ---------------------------------------------------------------------------

export interface VerticalStarterArtifactPreview {
  readonly kind: "page" | "offering" | "outlet" | "checklist";
  readonly label: string;
  readonly detail: string;
  readonly draftOnly: true;
}

export interface VerticalStarterPresetCatalogEntry {
  readonly id: VerticalStarterPresetId;
  readonly storagePresetId: StarterPresetId;
  readonly name: string;
  readonly shortName: string;
  readonly shortDescription: string;
  readonly description: string;
  readonly milestone: "M1" | "M2";
  readonly available: true;
  readonly verticalModule: string;
  readonly recommendedThemeId: "compro" | "sales" | "travel" | "resto";
  readonly manageModuleHrefSuffix: string;
  readonly manageModuleLabel: string;
  readonly sectionSummary: readonly {
    readonly type: ClosedSectionType;
    readonly label: string;
    readonly optional: boolean;
  }[];
  readonly starterArtifacts: readonly VerticalStarterArtifactPreview[];
  readonly safetyNote: string;
  readonly complianceNotice: string | null;
}

export const VERTICAL_STARTER_PRESET_CATALOG: readonly VerticalStarterPresetCatalogEntry[] = [
  {
    id: "company_profile",
    storagePresetId: "company_profile",
    name: "Profil Perusahaan",
    shortName: "Profil Perusahaan",
    shortDescription:
      "Struktur lengkap profil usaha B2B & korporat: hero, tentang kami, layanan, portofolio, logo mitra, testimoni, FAQ, dan kontak.",
    description:
      "Menyiapkan komposisi draf beranda profil perusahaan beserta daftar periksa kesiapan terbit. Seluruh teks contoh ditandai jelas, tetap berstatus draf, dan tidak pernah menghapus konten yang sudah ada.",
    milestone: "M1",
    available: true,
    verticalModule: "Core CMS (TASK-043)",
    recommendedThemeId: "compro",
    manageModuleHrefSuffix: "/pages",
    manageModuleLabel: "Kelola Halaman",
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
    starterArtifacts: [
      {
        kind: "page",
        label: "Draf Beranda Profil Perusahaan (8 bagian)",
        detail: "Bagian bertanda [Contoh] tetap berstatus draf hingga disunting pemilik.",
        draftOnly: true,
      },
      {
        kind: "checklist",
        label: "Daftar Periksa Kesiapan Terbit Profil Perusahaan",
        detail: "Identitas usaha, konten awal, kontak WA, privasi, pratinjau, dan domain.",
        draftOnly: true,
      },
    ],
    safetyNote:
      "Tanpa ulasan palsu, tanpa logo klien fiktif, dan tanpa angka pencapaian buatan. Semua konten awal berstatus draf.",
    complianceNotice: null,
  },
  {
    id: "professional_services",
    storagePresetId: "services",
    name: "Layanan Profesional",
    shortName: "Layanan Profesional",
    shortDescription:
      "Etalase layanan konsultasi & profesi dengan panduan mode harga (Mulai dari / Harga Tetap / Konsultasi), tahapan Cara Kerja, FAQ, dan kontak spesialis.",
    description:
      "Menggunakan modul Layanan Profesional (TASK-035) untuk menyiapkan draf beranda, draf halaman konsultasi, draf penawaran layanan tervalidasi skema konsultasi, serta daftar periksa terbit jasa.",
    milestone: "M2",
    available: true,
    verticalModule: "Professional Services (TASK-035)",
    recommendedThemeId: "sales",
    manageModuleHrefSuffix: "/catalog/services",
    manageModuleLabel: "Kelola Layanan Profesional",
    sectionSummary: [
      { type: "hero", label: "Hero Layanan Profesional", optional: false },
      { type: "services_grid", label: "Etalase Paket Layanan", optional: false },
      { type: "features", label: "Tahapan Cara Kerja", optional: true },
      { type: "about", label: "Profil Tim & Pendekatan", optional: false },
      { type: "gallery", label: "Dokumentasi & Portofolio", optional: true },
      { type: "faq", label: "FAQ Konsultasi", optional: true },
      { type: "contact_location", label: "Kontak & Konsultasi", optional: false },
    ],
    starterArtifacts: [
      {
        kind: "page",
        label: "Draf Beranda & Halaman Konsultasi",
        detail: "Struktur 7 bagian draf beranda + draf halaman alur konsultasi bertanda CONTOH.",
        draftOnly: true,
      },
      {
        kind: "offering",
        label: "Draf Layanan Konsultasi (ServiceConsultationAttributesSchema)",
        detail: "Mode harga konsultasi tanpa nominal fiktif + 3 langkah Cara Kerja siap disunting ke mode Mulai dari / Harga Tetap / Konsultasi.",
        draftOnly: true,
      },
      {
        kind: "checklist",
        label: "Daftar Periksa Terbit Layanan Profesional",
        detail: "Validasi mode harga transparan, langkah Cara Kerja, dan kontak spesialis.",
        draftOnly: true,
      },
    ],
    safetyNote:
      "Tanpa harga fiktif, tanpa ulasan/testimoni palsu, tanpa keranjang belanja, dan tanpa klaim izin atau sertifikasi buatan.",
    complianceNotice:
      "Untuk kategori kesehatan/medis atau profesi teregulasi, testimoni dinonaktifkan secara default sesuai ketentuan etika & Permenkes.",
  },
  {
    id: "travel_umrah",
    storagePresetId: "travel",
    name: "Travel & Wisata",
    shortName: "Travel & Wisata",
    shortDescription:
      "Etalase paket perjalanan biro travel & wisata dengan rencana perjalanan harian, jadwal tanggal indikatif, panduan transparansi, dan kontak pertanyaan paket.",
    description:
      "Menggunakan modul Travel & Umrah (TASK-020) untuk menyiapkan draf beranda, draf panduan perjalanan, draf paket tur umum (`general_tour`) bertanggal indikatif tanpa kuota kursi fiktif, serta daftar periksa terbit travel.",
    milestone: "M2",
    available: true,
    verticalModule: "Travel & Umrah (TASK-020)",
    recommendedThemeId: "travel",
    manageModuleHrefSuffix: "/catalog/travel",
    manageModuleLabel: "Kelola Paket Travel",
    sectionSummary: [
      { type: "hero", label: "Hero Biro Perjalanan", optional: false },
      { type: "tours_grid", label: "Etalase Paket Perjalanan", optional: false },
      { type: "features", label: "Standar Transparansi Paket", optional: true },
      { type: "about", label: "Tentang Biro Perjalanan", optional: false },
      { type: "gallery", label: "Galeri Dokumentasi Tur", optional: true },
      { type: "faq", label: "FAQ Keberangkatan", optional: true },
      { type: "contact_location", label: "Kontak & Pertanyaan Paket", optional: false },
    ],
    starterArtifacts: [
      {
        kind: "page",
        label: "Draf Beranda & Halaman Panduan Keberangkatan",
        detail: "Komposisi draf biro perjalanan (bukan OTA/tiket) bertanda CONTOH.",
        draftOnly: true,
      },
      {
        kind: "offering",
        label: "Draf Paket Tur Umum (`general_tour` — TravelPackageAttributesSchema)",
        detail: "Rencana perjalanan 3 hari 2 malam + tanggal keberangkatan indikatif `YYYY-MM-DD` tanpa kuota kursi/harga/maskapai fiktif.",
        draftOnly: true,
      },
      {
        kind: "checklist",
        label: "Daftar Periksa Travel & Gerbang SK PPIU Umrah (DEC-042)",
        detail: "Mencakup panduan gerbang izin SK PPIU Kemenag + verifikasi operator sebelum terbit paket Umrah.",
        draftOnly: true,
      },
    ],
    safetyNote:
      "Tanpa harga palsu, tanpa maskapai/hotel fiktif, tanpa bar kuota kursi buatan, dan tanpa penerbitan otomatis paket Umrah.",
    complianceNotice:
      "DEC-042 (UU 8/2019): Preset hanya membuat draf paket tur umum (`general_tour`). Publikasi paket Umrah/Haji wajib mengisi nomor izin resmi SK PPIU/PIHK Kemenag, lulus verifikasi operator PunyaSitus, dan persetujuan counsel gate.",
  },
  {
    id: "multi_outlet",
    storagePresetId: "outlets",
    name: "Multi-Gerai Offline",
    shortName: "Multi-Gerai Offline",
    shortDescription:
      "Etalase usaha offline & multi-cabang: menu/produk, direktori gerai dengan petunjuk arah tanpa JS, galeri suasana, serta daftar periksa Google Business Profile.",
    description:
      "Menggunakan modul Direktori Multi-Gerai (TASK-019) & Google Business Profile (TASK-073) untuk menyiapkan draf beranda, draf halaman lokasi gerai, templat draf gerai tanpa alamat/koordinat fiktif, dan daftar periksa multi-gerai.",
    milestone: "M2",
    available: true,
    verticalModule: "Multi-Outlet Directory (TASK-019)",
    recommendedThemeId: "resto",
    manageModuleHrefSuffix: "/outlets",
    manageModuleLabel: "Kelola Direktori Gerai",
    sectionSummary: [
      { type: "hero", label: "Hero Usaha Offline", optional: false },
      { type: "products_grid", label: "Etalase Menu & Produk", optional: false },
      { type: "branches", label: "Direktori Gerai & Cabang", optional: false },
      { type: "about", label: "Tentang Usaha & Cerita", optional: false },
      { type: "gallery", label: "Galeri Suasana Gerai", optional: true },
      { type: "faq", label: "FAQ Kunjungan & Reservasi", optional: true },
      { type: "contact_location", label: "Kontak Pusat & Arah", optional: false },
    ],
    starterArtifacts: [
      {
        kind: "page",
        label: "Draf Beranda & Halaman Direktori Gerai",
        detail: "Komposisi draf etalase menu/produk dan direktori cabang bertanda CONTOH.",
        draftOnly: true,
      },
      {
        kind: "outlet",
        label: "Templat Draf Gerai Utama (TASK-019 `branches`)",
        detail: "Tersimpan berstatus `draft` & nonaktif (`active = false`) tanpa alamat, koordinat GPS, nomor telepon, atau jam buka fiktif.",
        draftOnly: true,
      },
      {
        kind: "checklist",
        label: "Daftar Periksa Multi-Gerai & Google Business Profile",
        detail: "Lengkapi alamat asli, jam mingguan/libur, tautan Maps, dan panduan resmi Google Business Profile.",
        draftOnly: true,
      },
    ],
    safetyNote:
      "Tanpa alamat palsu, tanpa koordinat GPS fiktif, tanpa jam operasional karangan, dan tanpa ulasan/rating palsu. Peta tertanam hanya dimuat setelah persetujuan pengunjung.",
    complianceNotice:
      "PunyaSitus tidak memanggil API Google Business Profile dan tidak menyalin teks ulasan atau skema AggregateRating.",
  },
] as const;

export function getVerticalStarterPresetCatalogEntry(
  presetId: string,
): VerticalStarterPresetCatalogEntry | null {
  const canonical = resolveCanonicalVerticalPresetId(presetId);
  if (!canonical) return null;
  return VERTICAL_STARTER_PRESET_CATALOG.find((entry) => entry.id === canonical) ?? null;
}

// ---------------------------------------------------------------------------
// Strict Input Schemas for M2 Vertical Preset Provisioning
// ---------------------------------------------------------------------------

const VERTICAL_SETUP_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{3,127}$/;

const VerticalSetupKeySchema = z
  .string()
  .trim()
  .min(4, "setupKey minimal 4 karakter")
  .max(128, "setupKey maksimal 128 karakter")
  .regex(
    VERTICAL_SETUP_KEY_RE,
    "setupKey hanya boleh berisi huruf, angka, titik, garis bawah, titik dua, atau tanda hubung",
  );

const VerticalApplyModeSchema = z.enum(["preserve_existing", "merge_draft"]);

export const VerticalStarterPresetIdSchema = z.enum(ALL_VERTICAL_PRESET_IDS);

export const ApplyVerticalStarterPresetInputSchema = z
  .object({
    presetId: z
      .string()
      .trim()
      .min(1, "presetId wajib diisi.")
      .max(64)
      .refine((val) => resolveCanonicalVerticalPresetId(val) !== null, {
        message:
          "presetId tidak dikenali. Pilih salah satu dari company_profile, professional_services, travel_umrah, atau multi_outlet.",
      }),
    setupKey: VerticalSetupKeySchema.optional(),
    operationKey: VerticalSetupKeySchema.optional(),
    applyMode: VerticalApplyModeSchema.default("preserve_existing"),
    confirmSwitch: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const resolvedKey = val.setupKey ?? val.operationKey;
    if (!resolvedKey) {
      ctx.addIssue({
        code: "custom",
        path: ["setupKey"],
        message: "setupKey (atau operationKey) wajib diisi untuk menjamin idempotensi.",
      });
    }
    if (val.setupKey && val.operationKey && val.setupKey !== val.operationKey) {
      ctx.addIssue({
        code: "custom",
        path: ["setupKey"],
        message: "setupKey dan operationKey tidak boleh berbeda jika keduanya dikirim.",
      });
    }
  });

export type ApplyVerticalStarterPresetInput = z.infer<
  typeof ApplyVerticalStarterPresetInputSchema
>;

export function computeVerticalPresetSetupHash(input: {
  readonly tenantId: string;
  readonly presetId: VerticalStarterPresetId;
  readonly applyMode: PresetApplyMode;
  readonly confirmSwitch?: boolean;
}): string {
  const base = computePresetOperationHash({
    presetId: input.presetId,
    applyMode: input.applyMode,
  });
  return `m2:${input.tenantId.trim()}:${base}:${input.confirmSwitch === true ? "switch" : "keep"}`;
}

// ---------------------------------------------------------------------------
// Vertical Draft Starter Artifacts Types
// ---------------------------------------------------------------------------

export interface StarterDraftPageSpec {
  readonly slug: string;
  readonly title: string;
  readonly isHomepage: boolean;
  readonly status: "draft";
  readonly sections: readonly AnyValidatedPageSection[];
}

export interface StarterDraftServiceOfferingSpec {
  readonly offeringType: "service";
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly priceMode: "on_request";
  readonly price: null;
  readonly ctaMode: "whatsapp" | "inquiry";
  readonly status: "draft";
  readonly serviceAttributes: ServiceConsultationAttributes;
  readonly supportedPricingModes: readonly {
    readonly mode: ServicePricingMode;
    readonly label: string;
    readonly guidance: string;
  }[];
}

export interface StarterDraftTravelOfferingSpec {
  readonly offeringType: "tour";
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly priceMode: "on_request";
  readonly price: null;
  readonly ctaMode: "whatsapp" | "inquiry";
  readonly status: "draft";
  readonly travelAttributes: TravelPackageAttributes;
  readonly umrahComplianceGuidance: {
    readonly defaultPackageKind: "general_tour";
    readonly autoPublishesUmrah: false;
    readonly requiredGates: readonly [
      typeof UMRAH_LICENSE_REQUIRED,
      typeof UMRAH_OPERATOR_VERIFICATION_REQUIRED,
      typeof UMRAH_COUNSEL_GATE_REQUIRED,
    ];
    readonly noticeId: string;
  };
}

export interface StarterDraftOutletTemplateSpec {
  readonly slug: string;
  readonly name: string;
  readonly address: string;
  readonly city: null;
  readonly province: null;
  readonly postalCode: null;
  readonly phone: null;
  readonly whatsappE164: null;
  readonly mapsUrl: null;
  readonly latitude: null;
  readonly longitude: null;
  readonly weeklyHours: readonly [];
  readonly holidayHours: readonly [];
  readonly timezone: "Asia/Jakarta";
  readonly isPrimary: false;
  readonly status: "draft";
  readonly active: false;
}

export interface BuiltVerticalStarterComposition {
  readonly presetId: VerticalStarterPresetId;
  readonly storagePresetId: StarterPresetId;
  readonly sections: readonly AnyValidatedPageSection[];
  readonly secondaryPages: readonly StarterDraftPageSpec[];
  readonly starterServiceOffering: StarterDraftServiceOfferingSpec | null;
  readonly starterTravelOffering: StarterDraftTravelOfferingSpec | null;
  readonly starterOutletTemplate: StarterDraftOutletTemplateSpec | null;
  readonly sampleSectionIds: readonly string[];
  readonly optionalSectionIds: readonly string[];
  readonly defaultSelectedPublishSectionIds: readonly string[];
  readonly headerNavItems: readonly {
    readonly id: string;
    readonly label: string;
    readonly href: string;
  }[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly isHealthCategory: boolean;
}

export type VerticalStarterSeedContext = CompanyProfileStarterSeedContext;

const VERTICAL_OPTIONAL_SECTION_IDS: Readonly<Record<VerticalStarterPresetId, readonly string[]>> = {
  company_profile: [
    "preset-services",
    "preset-portfolio",
    "preset-trust-logos",
    "preset-testimonials",
    "preset-faq",
  ],
  professional_services: ["svc-process", "svc-portfolio", "svc-faq"],
  travel_umrah: ["trv-transparency", "trv-gallery", "trv-faq"],
  multi_outlet: ["out-gallery", "out-faq"],
};

export function isOptionalVerticalSection(
  presetId: VerticalStarterPresetId,
  sectionId: string,
): boolean {
  return VERTICAL_OPTIONAL_SECTION_IDS[presetId].includes(sectionId);
}

// ---------------------------------------------------------------------------
// 1. Professional Services Starter Preset Builder (TASK-035, REQ-030)
// ---------------------------------------------------------------------------

export const PROFESSIONAL_SERVICES_PRICING_MODE_GUIDES: readonly {
  readonly mode: ServicePricingMode;
  readonly label: string;
  readonly guidance: string;
}[] = SERVICE_PRICING_MODES.map((mode) => ({
  mode,
  label: SERVICE_PRICING_MODE_LABELS[mode],
  guidance:
    mode === "from"
      ? "Gunakan mode Mulai dari saat biaya awal dapat dicantumkan dalam Rupiah bulat dan menyesuaikan kompleksitas."
      : mode === "fixed"
        ? "Gunakan mode Harga Tetap saat ruang lingkup dan nominal biaya layanan sudah pasti."
        : "Gunakan mode Konsultasi / Penawaran Khusus saat biaya ditentukan setelah diskusi kebutuhan (tanpa nominal harga).",
}));

export function buildProfessionalServicesStarterPreset(
  ctx: VerticalStarterSeedContext,
): BuiltVerticalStarterComposition {
  const cleanName = ctx.businessName.trim() || "Usaha Layanan Anda";
  const businessCategory = ctx.businessCategory?.trim() || "LocalBusiness";
  const hasRealContact = Boolean(
    ctx.address?.trim() || ctx.phone?.trim() || ctx.whatsappPhone?.trim() || ctx.email?.trim(),
  );

  const rawHomeSections: unknown[] = [
    {
      id: "svc-hero",
      type: "hero",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: `${SAMPLE_COPY_PHRASE} — Layanan Profesional`,
        heading: `${SAMPLE_COPY_PHRASE} — ${cleanName}: Pendampingan & Solusi Profesional`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: jelaskan bidang keahlian utama, cakupan wilayah layanan, dan cara calon klien memulai konsultasi.",
        primaryCta: {
          label: "Jadwalkan Konsultasi",
          href: "#kontak",
          variant: "primary",
        },
        secondaryCta: {
          label: "Lihat Daftar Layanan",
          href: "/layanan",
          variant: "secondary",
        },
        highlights: [],
      },
    },
    {
      id: "svc-services",
      type: "services_grid",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Paket & Mode Harga",
        heading: `${SAMPLE_COPY_PHRASE} — Daftar Layanan & Skema Biaya`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: layanan yang diterbitkan di menu Layanan Profesional (mode Mulai dari, Harga Tetap, atau Konsultasi) akan tampil otomatis di sini.",
        offeringType: "service",
        limit: 6,
        itemSlugs: [],
        items: [],
        emptyMessage:
          "Belum ada layanan terbit. Lengkapi draf layanan pada menu Katalog > Layanan Profesional.",
        viewAllCta: {
          label: "Lihat Semua Layanan",
          href: "/layanan",
          variant: "secondary",
        },
      },
    },
    {
      id: "svc-process",
      type: "features",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Cara Kerja",
        heading: `${SAMPLE_COPY_PHRASE} — Tahapan Konsultasi & Pengerjaan`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan agar langkah kerja sesuai dengan prosedur layanan resmi usaha Anda.",
        columns: 3,
        items: [
          {
            title: `${SAMPLE_COPY_PHRASE} — 1. Konsultasi Kebutuhan Awal`,
            description:
              "CONTOH — jelaskan bagaimana calon klien menyampaikan ringkasan kebutuhan dan tujuan layanan.",
            badge: "Langkah 1",
          },
          {
            title: `${SAMPLE_COPY_PHRASE} — 2. Ruang Lingkup & Transparansi Biaya`,
            description:
              "CONTOH — jelaskan bagaimana tim Anda menyusun rincian pekerjaan, estimasi waktu, dan skema biaya tertulis.",
            badge: "Langkah 2",
          },
          {
            title: `${SAMPLE_COPY_PHRASE} — 3. Pelaksanaan & Serah Terima`,
            description:
              "CONTOH — jelaskan proses pengerjaan, pembaruan berkala, dan hasil akhir yang diserahkan kepada klien.",
            badge: "Langkah 3",
          },
        ],
      },
    },
    {
      id: "svc-about",
      type: "about",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Tentang Tim",
        heading: `${SAMPLE_DRAFT_MARKER_LABEL} Profil ${cleanName}`,
        subheading:
          "CONTOH — ganti dengan informasi resmi mengenai latar belakang keahlian dan cakupan layanan tim Anda.",
        bodyHtml:
          "<p>[Contoh Draf] CONTOH — Tuliskan profil keahlian usaha secara faktual tanpa klaim angka klien, penghargaan, atau izin profesi yang belum terverifikasi.</p>",
        milestones: [],
      },
    },
    {
      id: "svc-portfolio",
      type: "gallery",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "Portofolio",
        heading: "Dokumentasi & Studi Kasus Layanan",
        subheading:
          "Unggah dokumentasi proyek asli yang disetujui klien melalui Media sebelum mengaktifkan bagian ini.",
        columns: 3,
        items: [],
      },
    },
    {
      id: "svc-faq",
      type: "faq",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "FAQ Layanan",
        heading: `${SAMPLE_MARKER_LABEL} Pertanyaan Seputar Konsultasi`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan agar sesuai dengan ketentuan konsultasi usaha Anda.",
        items: [
          {
            question: `${SAMPLE_COPY_PHRASE} — Bagaimana skema penentuan biaya layanan?`,
            answer:
              "CONTOH — ubah sebelum diterbitkan: jelaskan kapan klien memilih paket Harga Tetap, Mulai dari, atau Penawaran Khusus setelah diskusi awal.",
            defaultOpen: false,
          },
        ],
      },
    },
    {
      id: "svc-contact",
      type: "contact_location",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Kontak Konsultasi",
        heading: `Hubungi ${cleanName}`,
        subheading: hasRealContact
          ? "Hubungi tim kami untuk menjadwalkan sesi konsultasi awal sesuai kebutuhan Anda."
          : "CONTOH — ubah sebelum diterbitkan: lengkapi alamat kantor, nomor WhatsApp bisnis, dan email di Pengaturan.",
        ...(ctx.address?.trim() ? { address: ctx.address.trim() } : {}),
        ...(ctx.phone?.trim() ? { phone: ctx.phone.trim() } : {}),
        ...(ctx.whatsappPhone?.trim() ? { whatsappPhone: ctx.whatsappPhone.trim() } : {}),
        ...(ctx.email?.trim() ? { email: ctx.email.trim() } : {}),
        branches: [],
      },
    },
  ];

  const validatedHome = validatePageSections(rawHomeSections, { businessCategory });

  const consultationPageSections = validatePageSections(
    [
      {
        id: "svc-consult-hero",
        type: "hero",
        schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
        enabled: true,
        config: {
          eyebrow: `${SAMPLE_COPY_PHRASE} — Halaman Konsultasi`,
          heading: `${SAMPLE_COPY_PHRASE} — Alur Permintaan Konsultasi ${cleanName}`,
          subheading:
            "CONTOH — ubah sebelum diterbitkan: sampaikan informasi apa saja yang sebaiknya disiapkan calon klien sebelum menghubungi tim spesialis.",
          primaryCta: {
            label: "Hubungi via WhatsApp",
            href: "#kontak",
            variant: "whatsapp",
          },
          highlights: [],
        },
      },
      {
        id: "svc-consult-body",
        type: "rich_text",
        schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
        enabled: true,
        config: {
          eyebrow: "Panduan Awal",
          heading: `${SAMPLE_COPY_PHRASE} — Informasi yang Perlu Disiapkan`,
          bodyHtml:
            "<p>[Contoh Draf] CONTOH — Jelaskan jam layanan konsultasi, durasi respons tim, serta dokumen umum yang membantu proses analisis awal. Jangan meminta data sensitif di formulir publik.</p>",
          milestones: [],
        },
      },
    ],
    { businessCategory },
  ).sections;

  // Validate starter service offering strictly through TASK-035 ServiceConsultationAttributesSchema!
  // Uses `inquiry` pricing mode so ZERO fabricated Rupiah prices are seeded.
  const rawServiceAttributes = {
    pricingMode: "inquiry" as const,
    pricingTiers: [
      {
        name: `${SAMPLE_COPY_PHRASE} — Paket Konsultasi Awal (Mode Konsultasi / Inquiry)`,
        pricingMode: "inquiry" as const,
        billingUnit: `${SAMPLE_COPY_PHRASE} — per sesi atau ruang lingkup`,
        summary:
          "CONTOH — Ubah ke mode Harga Tetap (fixed), Mulai dari (from), atau tetap Konsultasi (inquiry) setelah menentukan tarif resmi usaha Anda.",
        deliverables: [
          `${SAMPLE_COPY_PHRASE} — Sesi pemetaan kebutuhan awal bersama tim Anda`,
          `${SAMPLE_COPY_PHRASE} — Ringkasan rekomendasi dan estimasi ruang lingkup tertulis`,
        ],
        turnaroundLabel: `${SAMPLE_COPY_PHRASE} — Sesuai kesepakatan jadwal`,
      },
      {
        name: `${SAMPLE_COPY_PHRASE} — Paket Pendampingan Penuh (Siap Ubah ke Mulai Dari / Harga Tetap)`,
        pricingMode: "inquiry" as const,
        billingUnit: `${SAMPLE_COPY_PHRASE} — per proyek`,
        summary:
          "CONTOH — Masukkan nominal Rupiah asli pada menu Layanan Profesional sebelum menerbitkan layanan ini.",
        deliverables: [
          `${SAMPLE_COPY_PHRASE} — Pelaksanaan pekerjaan sesuai ruang lingkup yang disetujui`,
          `${SAMPLE_COPY_PHRASE} — Laporan hasil akhir dan sesi serah terima`,
        ],
        turnaroundLabel: `${SAMPLE_COPY_PHRASE} — Isi estimasi waktu pengerjaan resmi`,
      },
    ],
    processSteps: [
      {
        stepNumber: 1,
        title: `${SAMPLE_COPY_PHRASE} — Diskusi Kebutuhan Awal`,
        summary:
          "CONTOH — ubah sebelum diterbitkan: jelaskan alur penerimaan brief awal dari calon klien melalui WhatsApp atau formulir kontak.",
        estimatedDuration: `${SAMPLE_COPY_PHRASE} — Hari kerja ke-1`,
      },
      {
        stepNumber: 2,
        title: `${SAMPLE_COPY_PHRASE} — Penetapan Ruang Lingkup & Biaya`,
        summary:
          "CONTOH — ubah sebelum diterbitkan: jelaskan penyusunan proposal ruang lingkup kerja, jadwal, dan transparansi biaya.",
        estimatedDuration: `${SAMPLE_COPY_PHRASE} — Sesuai kebutuhan`,
      },
      {
        stepNumber: 3,
        title: `${SAMPLE_COPY_PHRASE} — Pengerjaan & Serah Terima`,
        summary:
          "CONTOH — ubah sebelum diterbitkan: jelaskan tahapan pelaksanaan pekerjaan hingga penyerahan dokumen hasil akhir.",
        estimatedDuration: `${SAMPLE_COPY_PHRASE} — Sesuai kesepakatan`,
      },
    ],
    serviceArea: `${SAMPLE_COPY_PHRASE} — Isi wilayah layanan resmi Anda`,
    turnaround: `${SAMPLE_COPY_PHRASE} — Isi estimasi durasi pengerjaan resmi`,
    serviceMode: "hybrid" as const,
  };

  // Validate with BOTH schema and canonical normalizer from TASK-035
  const schemaParsed = ServiceConsultationAttributesSchema.parse(rawServiceAttributes);
  const serviceAttributes = validateServiceConsultationAttributes(schemaParsed);

  const sampleSectionIds = computeSampleSectionIds(validatedHome.sections);

  return {
    presetId: "professional_services",
    storagePresetId: "services",
    sections: validatedHome.sections,
    secondaryPages: [
      {
        slug: "konsultasi-layanan",
        title: `${SAMPLE_COPY_PHRASE} — Jadwal & Alur Konsultasi`,
        isHomepage: false,
        status: "draft",
        sections: consultationPageSections,
      },
    ],
    starterServiceOffering: {
      offeringType: "service",
      slug: "contoh-layanan-konsultasi",
      title: `${SAMPLE_COPY_PHRASE} — Layanan Konsultasi Utama (Ubah Sebelum Diterbitkan)`,
      summary:
        "CONTOH — draf layanan profesional menggunakan skema mode harga (Mulai dari / Harga Tetap / Konsultasi) dan tahapan Cara Kerja. Ubah teks & tarif resmi sebelum terbit.",
      priceMode: "on_request",
      price: null,
      ctaMode: ctx.whatsappPhone?.trim() ? "whatsapp" : "inquiry",
      status: "draft",
      serviceAttributes,
      supportedPricingModes: PROFESSIONAL_SERVICES_PRICING_MODE_GUIDES,
    },
    starterTravelOffering: null,
    starterOutletTemplate: null,
    sampleSectionIds,
    optionalSectionIds: [...VERTICAL_OPTIONAL_SECTION_IDS.professional_services],
    defaultSelectedPublishSectionIds: validatedHome.sections
      .filter((s) => s.enabled)
      .map((s) => s.id),
    headerNavItems: [
      { id: "nav-beranda", label: "Beranda", href: "/" },
      { id: "nav-layanan", label: "Layanan", href: "/layanan" },
      { id: "nav-kontak", label: "Konsultasi", href: "#kontak" },
    ],
    warnings: validatedHome.warnings,
    isHealthCategory: validatedHome.isHealthCategory,
  };
}

// ---------------------------------------------------------------------------
// 2. Travel & Wisata / Umrah Starter Preset Builder (TASK-020, REQ-028, DEC-042)
// ---------------------------------------------------------------------------

export function buildTravelUmrahStarterPreset(
  ctx: VerticalStarterSeedContext,
): BuiltVerticalStarterComposition {
  const cleanName = ctx.businessName.trim() || "Biro Perjalanan Anda";
  const businessCategory = ctx.businessCategory?.trim() || "TravelAgency";
  const hasRealContact = Boolean(
    ctx.address?.trim() || ctx.phone?.trim() || ctx.whatsappPhone?.trim() || ctx.email?.trim(),
  );

  const rawHomeSections: unknown[] = [
    {
      id: "trv-hero",
      type: "hero",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: `${SAMPLE_COPY_PHRASE} — Biro Travel & Wisata`,
        heading: `${SAMPLE_COPY_PHRASE} — ${cleanName}: Rencana Perjalanan Terstruktur`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: jelaskan fokus paket wisata domestik/internasional Anda. Situs ini adalah etalase biro perjalanan dengan pertanyaan via WhatsApp, bukan portal tiket OTA.",
        primaryCta: {
          label: "Tanya Paket via WhatsApp",
          href: "#kontak",
          variant: "whatsapp",
        },
        secondaryCta: {
          label: "Lihat Paket Perjalanan",
          href: "/tour",
          variant: "secondary",
        },
        highlights: [],
      },
    },
    {
      id: "trv-packages",
      type: "tours_grid",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Paket Perjalanan",
        heading: `${SAMPLE_COPY_PHRASE} — Pilihan Paket Tur & Wisata`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: paket perjalanan yang sudah Anda lengkapi dan terbitkan pada menu Paket Travel akan tampil otomatis di bagian ini.",
        offeringType: "tour",
        limit: 6,
        itemSlugs: [],
        items: [],
        emptyMessage:
          "Belum ada paket perjalanan terbit. Lengkapi draf paket pada menu Katalog > Paket Travel.",
        viewAllCta: {
          label: "Lihat Semua Paket",
          href: "/tour",
          variant: "secondary",
        },
      },
    },
    {
      id: "trv-transparency",
      type: "features",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Transparansi Informasi",
        heading: `${SAMPLE_COPY_PHRASE} — Standar Informasi Paket Perjalanan`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: tampilkan hanya fakta resmi yang benar-benar diverifikasi biro perjalanan Anda.",
        columns: 3,
        items: [
          {
            title: `${SAMPLE_COPY_PHRASE} — Rencana Perjalanan Harian Jelas`,
            description:
              "CONTOH — setiap paket memuat susunan kegiatan harian dan rincian fasilitas termasuk maupun tidak termasuk.",
            badge: "Itinerary",
          },
          {
            title: `${SAMPLE_COPY_PHRASE} — Jadwal Tanggal Indikatif`,
            description:
              "CONTOH — tanggal keberangkatan ditampilkan informatif (tanpa klaim kuota kursi otomatis); konfirmasi dilakukan langsung dengan tim.",
            badge: "Jadwal",
          },
          {
            title: `${SAMPLE_COPY_PHRASE} — Ketentuan Izin Umrah (SK PPIU)`,
            description:
              "CONTOH — khusus penyelenggaraan Umrah, publikasi hanya dibuka setelah nomor SK PPIU Kemenag diisi dan diverifikasi operator sesuai DEC-042.",
            badge: "DEC-042",
          },
        ],
      },
    },
    {
      id: "trv-about",
      type: "about",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Tentang Biro Perjalanan",
        heading: `${SAMPLE_DRAFT_MARKER_LABEL} Mengenal ${cleanName}`,
        subheading:
          "CONTOH — ganti dengan informasi resmi badan usaha, alamat kantor operasional, dan layanan perjalanan Anda.",
        bodyHtml:
          "<p>[Contoh Draf] CONTOH — Tuliskan profil biro perjalanan secara faktual. Jangan mencantumkan nomor izin SK PPIU/PIHK atau klaim kemitraan maskapai/hotel yang belum aktif dan terverifikasi.</p>",
        milestones: [],
      },
    },
    {
      id: "trv-gallery",
      type: "gallery",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "Dokumentasi",
        heading: "Galeri Dokumentasi Perjalanan",
        subheading:
          "Unggah foto dokumentasi perjalanan asli milik usaha Anda melalui Media sebelum mengaktifkan bagian ini.",
        columns: 3,
        items: [],
      },
    },
    {
      id: "trv-faq",
      type: "faq",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "FAQ Travel",
        heading: `${SAMPLE_MARKER_LABEL} Pertanyaan Seputar Keberangkatan`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan agar sesuai dengan prosedur pendaftaran biro perjalanan Anda.",
        items: [
          {
            question: `${SAMPLE_COPY_PHRASE} — Bagaimana cara menanyakan jadwal keberangkatan yang tersedia?`,
            answer:
              "CONTOH — ubah sebelum diterbitkan: jelaskan alur konsultasi paket, persyaratan dokumen perjalanan, dan kontak resmi pendaftaran.",
            defaultOpen: false,
          },
        ],
      },
    },
    {
      id: "trv-contact",
      type: "contact_location",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Kontak Biro Travel",
        heading: `Hubungi ${cleanName}`,
        subheading: hasRealContact
          ? "Hubungi tim perjalanan kami untuk informasi jadwal keberangkatan dan rincian paket."
          : "CONTOH — ubah sebelum diterbitkan: lengkapi alamat kantor, nomor WhatsApp resmi, dan email di Pengaturan.",
        ...(ctx.address?.trim() ? { address: ctx.address.trim() } : {}),
        ...(ctx.phone?.trim() ? { phone: ctx.phone.trim() } : {}),
        ...(ctx.whatsappPhone?.trim() ? { whatsappPhone: ctx.whatsappPhone.trim() } : {}),
        ...(ctx.email?.trim() ? { email: ctx.email.trim() } : {}),
        branches: [],
      },
    },
  ];

  const validatedHome = validatePageSections(rawHomeSections, { businessCategory });

  const guidePageSections = validatePageSections(
    [
      {
        id: "trv-guide-hero",
        type: "hero",
        schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
        enabled: true,
        config: {
          eyebrow: `${SAMPLE_COPY_PHRASE} — Panduan Keberangkatan`,
          heading: `${SAMPLE_COPY_PHRASE} — Panduan Persiapan Perjalanan ${cleanName}`,
          subheading:
            "CONTOH — ubah sebelum diterbitkan: rangkum dokumen perjalanan, ketentuan pendaftaran, dan kanal verifikasi resmi usaha Anda.",
          primaryCta: {
            label: "Tanya Tim Travel",
            href: "#kontak",
            variant: "whatsapp",
          },
          highlights: [],
        },
      },
      {
        id: "trv-guide-body",
        type: "rich_text",
        schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
        enabled: true,
        config: {
          eyebrow: "Kepatuhan & Transparansi",
          heading: `${SAMPLE_COPY_PHRASE} — Ketentuan Paket Wisata & Gerbang Izin Umrah`,
          bodyHtml:
            "<p>[Contoh Draf] CONTOH — Untuk paket wisata umum, cantumkan durasi, transportasi, akomodasi, serta rincian termasuk/tidak termasuk. Khusus paket Umrah, pastikan nomor SK PPIU Kemenag telah diisi dan diverifikasi operator sebelum diterbitkan (DEC-042).</p>",
          milestones: [],
        },
      },
    ],
    { businessCategory },
  ).sections;

  // Validate starter general_tour offering strictly through TASK-020 TravelPackageAttributesSchema!
  // Strictly `general_tour` (NEVER auto-creates or publishes `umrah`), date-only `YYYY-MM-DD`
  // departures, ZERO fabricated prices/permits/airlines/hotels/seat counts!
  const rawTravelAttributes = {
    packageKind: "general_tour" as const,
    destination: `${SAMPLE_COPY_PHRASE} — Destinasi Wisata Pilihan Anda`,
    durationDays: 3,
    durationNights: 2,
    departureCity: `${SAMPLE_COPY_PHRASE} — Kota Keberangkatan`,
    itinerary: [
      {
        dayNumber: 1,
        title: `${SAMPLE_COPY_PHRASE} — Hari 1: Keberangkatan & Kedatangan`,
        summary:
          "CONTOH — ubah sebelum diterbitkan: jelaskan titik kumpul, waktu kedatangan, dan agenda hari pertama sesuai paket resmi Anda.",
        city: `${SAMPLE_COPY_PHRASE} — Kota Tujuan`,
      },
      {
        dayNumber: 2,
        title: `${SAMPLE_COPY_PHRASE} — Hari 2: Rangkaian Kunjungan Utama`,
        summary:
          "CONTOH — ubah sebelum diterbitkan: cantumkan rute kunjungan harian dan agenda utama secara faktual.",
        city: `${SAMPLE_COPY_PHRASE} — Kota Tujuan`,
      },
      {
        dayNumber: 3,
        title: `${SAMPLE_COPY_PHRASE} — Hari 3: Kepulangan`,
        summary:
          "CONTOH — ubah sebelum diterbitkan: jelaskan persiapan kepulangan dan pengantaran ke bandara atau titik akhir.",
        city: `${SAMPLE_COPY_PHRASE} — Kota Asal`,
      },
    ],
    departures: [
      {
        departureDate: "2027-01-15",
        returnDate: "2027-01-17",
        departureCity: `${SAMPLE_COPY_PHRASE} — Kota Keberangkatan`,
        label: `${SAMPLE_COPY_PHRASE} — Jadwal indikatif (ubah ke tanggal resmi sebelum terbit)`,
      },
    ],
    inclusions: [
      `${SAMPLE_COPY_PHRASE} — Isi rincian fasilitas yang termasuk dalam paket resmi Anda`,
    ],
    exclusions: [
      `${SAMPLE_COPY_PHRASE} — Isi rincian pengeluaran pribadi atau biaya yang tidak termasuk`,
    ],
  };

  const schemaParsed = TravelPackageAttributesSchema.parse(rawTravelAttributes);
  const travelAttributes = validateTravelPackageAttributes(schemaParsed);

  // Confirm DEC-042 fail-closed invariant: an unverified Umrah package is strictly blocked!
  const umrahGateCheck = canPublishTravelPackage({ packageKind: "umrah" }, {});
  if (umrahGateCheck.allowed) {
    throw new Error("Invariant violation: unverified Umrah package must remain fail-closed.");
  }

  const sampleSectionIds = computeSampleSectionIds(validatedHome.sections);

  return {
    presetId: "travel_umrah",
    storagePresetId: "travel",
    sections: validatedHome.sections,
    secondaryPages: [
      {
        slug: "panduan-keberangkatan",
        title: `${SAMPLE_COPY_PHRASE} — Panduan Persiapan & Ketentuan Perjalanan`,
        isHomepage: false,
        status: "draft",
        sections: guidePageSections,
      },
    ],
    starterServiceOffering: null,
    starterTravelOffering: {
      offeringType: "tour",
      slug: "contoh-paket-wisata-3h2m",
      title: `${SAMPLE_COPY_PHRASE} — Paket Wisata 3 Hari 2 Malam (Ubah Sebelum Diterbitkan)`,
      summary:
        "CONTOH — draf paket tur umum (general_tour) dengan itinerary 3 hari dan tanggal keberangkatan indikatif YYYY-MM-DD. Khusus paket Umrah wajib memenuhi gerbang SK PPIU & verifikasi operator (DEC-042).",
      priceMode: "on_request",
      price: null,
      ctaMode: ctx.whatsappPhone?.trim() ? "whatsapp" : "inquiry",
      status: "draft",
      travelAttributes,
      umrahComplianceGuidance: {
        defaultPackageKind: "general_tour",
        autoPublishesUmrah: false,
        requiredGates: [
          UMRAH_LICENSE_REQUIRED,
          UMRAH_OPERATOR_VERIFICATION_REQUIRED,
          UMRAH_COUNSEL_GATE_REQUIRED,
        ],
        noticeId:
          "Paket Umrah/Haji tidak pernah diterbitkan otomatis. Isi nomor izin resmi SK PPIU/PIHK Kemenag, selesaikan verifikasi operator PunyaSitus, dan pastikan counsel gate aktif sesuai DEC-042.",
      },
    },
    starterOutletTemplate: null,
    sampleSectionIds,
    optionalSectionIds: [...VERTICAL_OPTIONAL_SECTION_IDS.travel_umrah],
    defaultSelectedPublishSectionIds: validatedHome.sections
      .filter((s) => s.enabled)
      .map((s) => s.id),
    headerNavItems: [
      { id: "nav-beranda", label: "Beranda", href: "/" },
      { id: "nav-paket", label: "Paket Tur", href: "/tour" },
      { id: "nav-kontak", label: "Kontak", href: "#kontak" },
    ],
    warnings: validatedHome.warnings,
    isHealthCategory: validatedHome.isHealthCategory,
  };
}

// ---------------------------------------------------------------------------
// 3. Multi-Outlet / Offline Starter Preset Builder (TASK-019, REQ-029 + TASK-073)
// ---------------------------------------------------------------------------

export function buildMultiOutletStarterPreset(
  ctx: VerticalStarterSeedContext,
): BuiltVerticalStarterComposition {
  const cleanName = ctx.businessName.trim() || "Usaha Multi-Gerai Anda";
  const businessCategory = ctx.businessCategory?.trim() || "LocalBusiness";
  const hasRealContact = Boolean(
    ctx.address?.trim() || ctx.phone?.trim() || ctx.whatsappPhone?.trim() || ctx.email?.trim(),
  );

  const rawHomeSections: unknown[] = [
    {
      id: "out-hero",
      type: "hero",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: `${SAMPLE_COPY_PHRASE} — Usaha Multi-Gerai Offline`,
        heading: `${SAMPLE_COPY_PHRASE} — ${cleanName}: Temukan Gerai Terdekat Anda`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: perkenalkan menu/produk unggulan usaha Anda dan arahkan pengunjung ke gerai terdekat.",
        primaryCta: {
          label: "Lihat Lokasi Gerai",
          href: "#kontak",
          variant: "primary",
        },
        secondaryCta: {
          label: "Lihat Menu & Produk",
          href: "/produk",
          variant: "secondary",
        },
        highlights: [],
      },
    },
    {
      id: "out-catalog",
      type: "products_grid",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Menu & Produk",
        heading: `${SAMPLE_COPY_PHRASE} — Pilihan Menu & Produk Unggulan`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: menu atau produk yang Anda tambahkan pada menu Katalog akan tampil otomatis di bagian ini.",
        offeringType: "product",
        limit: 6,
        itemSlugs: [],
        items: [],
        emptyMessage:
          "Belum ada produk atau menu terbit. Tambahkan item melalui menu Katalog.",
        viewAllCta: {
          label: "Lihat Semua Produk",
          href: "/produk",
          variant: "secondary",
        },
      },
    },
    {
      id: "out-branches",
      type: "branches",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Direktori Gerai",
        heading: `${SAMPLE_COPY_PHRASE} — Lokasi Cabang & Jam Operasional`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan: lengkapi alamat asli, jam buka mingguan/libur, dan tautan Google Maps pada menu Direktori Gerai (maks. 10 gerai).",
        branches: [],
      },
    },
    {
      id: "out-about",
      type: "about",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Tentang Usaha",
        heading: `${SAMPLE_DRAFT_MARKER_LABEL} Cerita ${cleanName}`,
        subheading:
          "CONTOH — ganti dengan informasi resmi usaha, standar pelayanan di gerai, dan informasi kunjungan.",
        bodyHtml:
          "<p>[Contoh Draf] CONTOH — Tuliskan profil singkat usaha offline Anda secara faktual. Hindari mencantumkan alamat, jam buka, atau ulasan pelanggan yang belum diverifikasi.</p>",
        milestones: [],
      },
    },
    {
      id: "out-gallery",
      type: "gallery",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "Galeri Gerai",
        heading: "Dokumentasi Suasana & Produk",
        subheading:
          "Unggah foto asli suasana gerai atau produk melalui Media sebelum mengaktifkan bagian ini.",
        columns: 3,
        items: [],
      },
    },
    {
      id: "out-faq",
      type: "faq",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: false,
      config: {
        eyebrow: "FAQ Kunjungan",
        heading: `${SAMPLE_MARKER_LABEL} Pertanyaan Seputar Gerai`,
        subheading:
          "CONTOH — ubah sebelum diterbitkan agar sesuai dengan informasi parkir, reservasi, dan jam kunjungan gerai Anda.",
        items: [
          {
            question: `${SAMPLE_COPY_PHRASE} — Apakah pengunjung perlu melakukan reservasi sebelum datang ke gerai?`,
            answer:
              "CONTOH — ubah sebelum diterbitkan: jelaskan ketentuan kunjungan langsung, reservasi rombongan, atau pemesanan melalui WhatsApp.",
            defaultOpen: false,
          },
        ],
      },
    },
    {
      id: "out-contact",
      type: "contact_location",
      schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
      enabled: true,
      config: {
        eyebrow: "Kontak Pusat",
        heading: `Hubungi ${cleanName}`,
        subheading: hasRealContact
          ? "Hubungi kami untuk pertanyaan gerai terdekat, jam operasional, atau pemesanan."
          : "CONTOH — ubah sebelum diterbitkan: lengkapi alamat pusat, WhatsApp bisnis, dan tautan ulasan Google Maps di Pengaturan Bisnis.",
        ...(ctx.address?.trim() ? { address: ctx.address.trim() } : {}),
        ...(ctx.phone?.trim() ? { phone: ctx.phone.trim() } : {}),
        ...(ctx.whatsappPhone?.trim() ? { whatsappPhone: ctx.whatsappPhone.trim() } : {}),
        ...(ctx.email?.trim() ? { email: ctx.email.trim() } : {}),
        branches: [],
      },
    },
  ];

  const validatedHome = validatePageSections(rawHomeSections, { businessCategory });

  const directoryPageSections = validatePageSections(
    [
      {
        id: "out-dir-hero",
        type: "hero",
        schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
        enabled: true,
        config: {
          eyebrow: `${SAMPLE_COPY_PHRASE} — Halaman Direktori Gerai`,
          heading: `${SAMPLE_COPY_PHRASE} — Daftar Gerai Resmi ${cleanName}`,
          subheading:
            "CONTOH — ubah sebelum diterbitkan: kelola hingga 10 gerai di menu Gerai agar petunjuk arah Google Maps dan jam operasional tampil akurat.",
          primaryCta: {
            label: "Hubungi Pusat",
            href: "#kontak",
            variant: "primary",
          },
          highlights: [],
        },
      },
      {
        id: "out-dir-branches",
        type: "branches",
        schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
        enabled: true,
        config: {
          eyebrow: "Daftar Cabang",
          heading: `${SAMPLE_COPY_PHRASE} — Cabang Aktif`,
          subheading:
            "CONTOH — ubah sebelum diterbitkan: hanya gerai berstatus Terbit & Aktif yang ditampilkan di situs publik.",
          branches: [],
        },
      },
    ],
    { businessCategory },
  ).sections;

  const sampleSectionIds = computeSampleSectionIds(validatedHome.sections);

  return {
    presetId: "multi_outlet",
    storagePresetId: "outlets",
    sections: validatedHome.sections,
    secondaryPages: [
      {
        slug: "lokasi-gerai",
        title: `${SAMPLE_COPY_PHRASE} — Direktori Gerai & Jam Operasional`,
        isHomepage: false,
        status: "draft",
        sections: directoryPageSections,
      },
    ],
    starterServiceOffering: null,
    starterTravelOffering: null,
    starterOutletTemplate: {
      slug: "contoh-gerai-utama",
      name: `${SAMPLE_COPY_PHRASE} — Gerai Utama (Ubah Sebelum Diterbitkan)`,
      address:
        "CONTOH — Isi alamat lengkap gerai resmi Anda sebelum mengaktifkan dan menerbitkan gerai ini",
      city: null,
      province: null,
      postalCode: null,
      phone: null,
      whatsappE164: null,
      mapsUrl: null,
      latitude: null,
      longitude: null,
      weeklyHours: [],
      holidayHours: [],
      timezone: "Asia/Jakarta",
      isPrimary: false,
      status: "draft",
      active: false,
    },
    sampleSectionIds,
    optionalSectionIds: [...VERTICAL_OPTIONAL_SECTION_IDS.multi_outlet],
    defaultSelectedPublishSectionIds: validatedHome.sections
      .filter((s) => s.enabled)
      .map((s) => s.id),
    headerNavItems: [
      { id: "nav-beranda", label: "Beranda", href: "/" },
      { id: "nav-produk", label: "Produk", href: "/produk" },
      { id: "nav-gerai", label: "Lokasi Gerai", href: "#kontak" },
    ],
    warnings: validatedHome.warnings,
    isHealthCategory: validatedHome.isHealthCategory,
  };
}

// ---------------------------------------------------------------------------
// Unified Vertical Starter Preset Dispatcher (M1 + M2)
// ---------------------------------------------------------------------------

export function buildVerticalStarterComposition(
  presetId: string,
  ctx: VerticalStarterSeedContext,
): BuiltVerticalStarterComposition {
  const canonical = resolveCanonicalVerticalPresetId(presetId);
  if (!canonical) {
    throw new PresetDomainError(
      422,
      "UNSUPPORTED_PRESET",
      `Preset "${presetId}" tidak dikenali. Pilih company_profile, professional_services, travel_umrah, atau multi_outlet.`,
      [
        {
          field: "presetId",
          code: "UNSUPPORTED_PRESET",
          message: `Unknown vertical preset "${presetId}"`,
        },
      ],
    );
  }

  switch (canonical) {
    case "company_profile": {
      const m1 = buildCompanyProfileStarterComposition(ctx);
      return {
        presetId: "company_profile",
        storagePresetId: "company_profile",
        sections: m1.sections,
        secondaryPages: [],
        starterServiceOffering: null,
        starterTravelOffering: null,
        starterOutletTemplate: null,
        sampleSectionIds: m1.sampleSectionIds,
        optionalSectionIds: m1.optionalSectionIds,
        defaultSelectedPublishSectionIds: m1.defaultSelectedPublishSectionIds,
        headerNavItems: [
          { id: "nav-beranda", label: "Beranda", href: "/" },
          { id: "nav-layanan", label: "Layanan", href: "/layanan" },
          { id: "nav-kontak", label: "Kontak", href: "#kontak" },
        ],
        warnings: m1.warnings,
        isHealthCategory: m1.isHealthCategory,
      };
    }
    case "professional_services":
      return buildProfessionalServicesStarterPreset(ctx);
    case "travel_umrah":
      return buildTravelUmrahStarterPreset(ctx);
    case "multi_outlet":
      return buildMultiOutletStarterPreset(ctx);
  }
}

// ---------------------------------------------------------------------------
// Selective Publication Guard for ALL 4 Vertical Presets (M1 + M2)
// ---------------------------------------------------------------------------

export function validateVerticalPresetSelectivePublish(params: {
  readonly presetId: string;
  readonly draftSections: readonly AnyValidatedPageSection[];
  readonly selectedSectionIds: readonly string[];
  readonly businessCategory?: string | null;
}): {
  readonly presetId: VerticalStarterPresetId;
  readonly selectedSections: readonly AnyValidatedPageSection[];
  readonly unpublishedDraftSectionIds: readonly string[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly missingOptionalSectionIds: readonly string[];
} {
  const canonical = resolveCanonicalVerticalPresetId(params.presetId);
  if (!canonical) {
    throw new PresetDomainError(
      422,
      "UNSUPPORTED_PRESET",
      `Preset "${params.presetId}" tidak dikenali.`,
      [
        {
          field: "presetId",
          code: "UNSUPPORTED_PRESET",
          message: `Unsupported preset "${params.presetId}"`,
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
  const invalidFields: PresetValidationField[] = [];
  for (const id of params.selectedSectionIds) {
    if (selectedSet.has(id)) {
      invalidFields.push({
        field: "selectedSectionIds",
        code: "DUPLICATE_SECTION_SELECTION",
        message: `Bagian "${id}" dipilih lebih dari satu kali.`,
        sectionId: id,
      });
    } else if (!byId.has(id)) {
      invalidFields.push({
        field: "selectedSectionIds",
        code: "UNKNOWN_SECTION_ID",
        message: `Bagian "${id}" tidak ditemukan dalam komposisi draf preset.`,
        sectionId: id,
      });
    } else {
      selectedSet.add(id);
    }
  }

  if (invalidFields.length > 0) {
    throw new PresetDomainError(
      422,
      "INVALID_SECTION_SELECTION",
      "Daftar bagian terpilih tidak valid.",
      invalidFields,
    );
  }

  const orderedSelectedInputs = params.draftSections
    .filter((s) => selectedSet.has(s.id))
    .map((s, idx) => ({
      id: s.id,
      type: s.type,
      schemaVersion: s.schemaVersion,
      enabled: true,
      order: idx,
      config: s.config,
    }));

  const validated = validatePageSections(orderedSelectedInputs, {
    businessCategory: params.businessCategory,
  });

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
      `Teks contoh belum boleh diterbitkan (${uniqueIds.join(", ")}). Ubah teks CONTOH dengan data asli usaha Anda atau batal pilih bagian tersebut sebelum menerbitkan.`,
      sampleFields,
    );
  }

  const unpublishedDraftSectionIds = params.draftSections
    .filter((s) => !selectedSet.has(s.id))
    .map((s) => s.id);
  const missingOptionalSectionIds = VERTICAL_OPTIONAL_SECTION_IDS[canonical].filter(
    (id) => !selectedSet.has(id),
  );

  return {
    presetId: canonical,
    selectedSections: validated.sections,
    unpublishedDraftSectionIds,
    warnings: validated.warnings,
    missingOptionalSectionIds,
  };
}

// ---------------------------------------------------------------------------
// Vertical Launch Checklist Evaluator (M1 + Services / Travel / Multi-Outlet)
// ---------------------------------------------------------------------------

export type VerticalLaunchChecklistItemId =
  | PresetChecklistItem["id"]
  | "services_pricing_tiers"
  | "services_process_steps"
  | "travel_itinerary_departures"
  | "travel_umrah_ppiu_gate"
  | "outlets_directory_hours";

export interface VerticalLaunchChecklistItem {
  readonly id: VerticalLaunchChecklistItemId;
  readonly label: string;
  readonly description: string;
  readonly status: "done" | "pending" | "optional_pending";
  readonly requiredForPublish: boolean;
  readonly detail: string;
  readonly actionLabel: string;
  readonly actionHref: string;
  readonly verticalScope: "shared" | VerticalStarterPresetId;
  readonly officialHelpUrl?: string;
  readonly helpArticleHref?: string;
}

export interface VerticalLaunchChecklistFacts {
  readonly presetId: VerticalStarterPresetId;
  readonly handle: string;
  readonly siteTitle: string | null;
  readonly businessName: string | null;
  readonly hasCustomizedDraftSection: boolean;
  readonly nonTrashedPagesCount: number;
  readonly nonTrashedOfferingsCount: number;
  readonly serviceOfferingsCount?: number;
  readonly publishedServiceOfferingsCount?: number;
  readonly tourOfferingsCount?: number;
  readonly publishedTourOfferingsCount?: number;
  readonly hasUmrahSkPpiuVerified?: boolean;
  readonly outletsCount?: number;
  readonly publishedOutletsCount?: number;
  readonly whatsappE164: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly hasPrivacyPage: boolean;
  readonly hasPreviewedPreset: boolean;
  readonly activeCustomHostname: string | null;
  readonly fallbackHost: string;
  readonly googleMapsReviewUrl?: string | null;
  readonly hasPublishedGoogleMapsReviewUrl?: boolean;
}

export interface VerticalLaunchChecklistSummary {
  readonly presetId: VerticalStarterPresetId;
  readonly items: readonly VerticalLaunchChecklistItem[];
  readonly completedCount: number;
  readonly totalCount: number;
  readonly requiredCompletedCount: number;
  readonly requiredTotalCount: number;
  readonly readyForFirstPublish: boolean;
}

export function evaluateVerticalLaunchChecklist(
  facts: VerticalLaunchChecklistFacts,
): VerticalLaunchChecklistSummary {
  const base = `/dashboard/${encodeURIComponent(facts.handle)}`;
  const sharedBase: PresetChecklistSummary = evaluatePresetChecklist({
    handle: facts.handle,
    siteTitle: facts.siteTitle,
    businessName: facts.businessName,
    hasCustomizedDraftSection: facts.hasCustomizedDraftSection,
    nonTrashedPagesCount: facts.nonTrashedPagesCount,
    nonTrashedOfferingsCount: facts.nonTrashedOfferingsCount,
    whatsappE164: facts.whatsappE164,
    phone: facts.phone,
    email: facts.email,
    hasPrivacyPage: facts.hasPrivacyPage,
    hasPreviewedPreset: facts.hasPreviewedPreset,
    activeCustomHostname: facts.activeCustomHostname,
    fallbackHost: facts.fallbackHost,
    ...(facts.presetId === "company_profile" && facts.googleMapsReviewUrl !== undefined
      ? {
          googleMapsReviewUrl: facts.googleMapsReviewUrl,
          hasPublishedGoogleMapsReviewUrl: facts.hasPublishedGoogleMapsReviewUrl,
        }
      : {}),
  });

  const sharedItems: VerticalLaunchChecklistItem[] = sharedBase.items.map((item) => ({
    ...item,
    verticalScope: "shared" as const,
  }));

  const verticalItems: VerticalLaunchChecklistItem[] = [];

  if (facts.presetId === "professional_services") {
    const publishedServices = facts.publishedServiceOfferingsCount ?? 0;
    const totalServices = facts.serviceOfferingsCount ?? 0;
    verticalItems.push(
      {
        id: "services_pricing_tiers",
        label: "Mode Harga Layanan (Mulai dari / Harga Tetap / Konsultasi)",
        description:
          "Tentukan skema harga transparan dan ganti teks CONTOH pada draf layanan profesional Anda.",
        status: publishedServices > 0 ? "done" : "optional_pending",
        requiredForPublish: false,
        detail:
          publishedServices > 0
            ? `${publishedServices} layanan profesional sudah terbit.`
            : totalServices > 0
              ? `${totalServices} draf layanan siap disunting — isi tarif resmi atau pilih mode Konsultasi.`
              : "Buat layanan pertama di menu Layanan Profesional.",
        actionLabel: "Atur Layanan",
        actionHref: `${base}/catalog/services`,
        verticalScope: "professional_services",
      },
      {
        id: "services_process_steps",
        label: "Tahapan Cara Kerja & Kontak Spesialis",
        description:
          "Pastikan urutan langkah kerja (1–10 langkah) dan nomor WhatsApp spesialis (opsional) sudah faktual.",
        status: publishedServices > 0 ? "done" : "optional_pending",
        requiredForPublish: false,
        detail:
          publishedServices > 0
            ? "Tahapan Cara Kerja sudah siap tampil di halaman detail layanan."
            : "Sunting langkah Cara Kerja pada draf layanan profesional tanpa klaim hasil pasti.",
        actionLabel: "Sunting Cara Kerja",
        actionHref: `${base}/catalog/services`,
        verticalScope: "professional_services",
      },
    );
  } else if (facts.presetId === "travel_umrah") {
    const publishedTours = facts.publishedTourOfferingsCount ?? 0;
    const totalTours = facts.tourOfferingsCount ?? 0;
    const umrahVerified = facts.hasUmrahSkPpiuVerified === true;
    verticalItems.push(
      {
        id: "travel_itinerary_departures",
        label: "Itinerary Harian & Jadwal Tanggal Indikatif",
        description:
          "Lengkapi rencana perjalanan harian, durasi, fasilitas termasuk/tidak termasuk, serta jadwal tanggal YYYY-MM-DD asli.",
        status: publishedTours > 0 ? "done" : "optional_pending",
        requiredForPublish: false,
        detail:
          publishedTours > 0
            ? `${publishedTours} paket perjalanan sudah terbit.`
            : totalTours > 0
              ? `${totalTours} draf paket tur umum siap disunting sebelum terbit.`
              : "Tambahkan paket perjalanan pertama di menu Paket Travel.",
        actionLabel: "Kelola Paket Travel",
        actionHref: `${base}/catalog/travel`,
        verticalScope: "travel_umrah",
      },
      {
        id: "travel_umrah_ppiu_gate",
        label: "Verifikasi SK PPIU Kemenag (Khusus Paket Umrah — DEC-042)",
        description:
          "Paket tur umum dapat terbit langsung. Paket Umrah/Haji ditahan otomatis hingga nomor SK PPIU/PIHK diisi dan diverifikasi operator.",
        status: umrahVerified ? "done" : "optional_pending",
        requiredForPublish: false,
        detail: umrahVerified
          ? "Izin SK PPIU telah terverifikasi operator."
          : "Opsional untuk tur umum — wajib isi SK PPIU & lulus verifikasi operator sebelum terbit paket Umrah (DEC-042).",
        actionLabel: "Cek Status SK PPIU",
        actionHref: `${base}/catalog/travel`,
        verticalScope: "travel_umrah",
      },
    );
  } else if (facts.presetId === "multi_outlet") {
    const publishedOutlets = facts.publishedOutletsCount ?? 0;
    const totalOutlets = facts.outletsCount ?? 0;
    const gbpStep = buildGoogleBusinessProfileChecklistStep({
      handle: facts.handle,
      publicSiteHref: `https://${facts.activeCustomHostname ?? facts.fallbackHost}`,
      googleMapsReviewUrl: facts.googleMapsReviewUrl ?? null,
      hasPublishedReviewUrl: facts.hasPublishedGoogleMapsReviewUrl,
    });

    verticalItems.push(
      {
        id: "outlets_directory_hours",
        label: "Alamat Asli Gerai, Jam Operasional & Tautan Peta",
        description:
          "Ganti templat draf gerai dengan alamat resmi, jam mingguan/hari libur, dan koordinat atau tautan Google Maps (maks. 10 gerai).",
        status: publishedOutlets > 0 ? "done" : "optional_pending",
        requiredForPublish: false,
        detail:
          publishedOutlets > 0
            ? `${publishedOutlets} gerai aktif sudah terbit di direktori publik.`
            : totalOutlets > 0
              ? `${totalOutlets} templat draf gerai tersimpan — lengkapi data resmi lalu aktifkan.`
              : "Tambahkan gerai pertama di menu Direktori Gerai.",
        actionLabel: "Kelola Gerai",
        actionHref: `${base}/outlets`,
        verticalScope: "multi_outlet",
      },
      {
        id: GBP_CHECKLIST_STEP_ID,
        label: gbpStep.label,
        description: gbpStep.description,
        status: gbpStep.status,
        requiredForPublish: false,
        detail: gbpStep.detail,
        actionLabel: gbpStep.actionLabel,
        actionHref: gbpStep.actionHref,
        verticalScope: "multi_outlet",
        officialHelpUrl: GBP_OFFICIAL_HELP_URLS.addWebsiteToProfile,
        helpArticleHref: GBP_OFFICIAL_HELP_URLS.punyasitusHelpArticle,
      },
    );
  }

  const allItems: readonly VerticalLaunchChecklistItem[] = [...sharedItems, ...verticalItems];
  const completedCount = allItems.filter((item) => item.status === "done").length;
  const requiredItems = allItems.filter((item) => item.requiredForPublish);
  const requiredCompletedCount = requiredItems.filter((item) => item.status === "done").length;

  return {
    presetId: facts.presetId,
    items: allItems,
    completedCount,
    totalCount: allItems.length,
    requiredCompletedCount,
    requiredTotalCount: requiredItems.length,
    readyForFirstPublish: requiredCompletedCount === requiredItems.length,
  };
}
