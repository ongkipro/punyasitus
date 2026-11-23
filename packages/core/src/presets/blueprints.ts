import { z } from "zod";
import {
  getPromptedCredentialsForCategory,
  type ClosedBusinessCategoryKey,
  type CredentialFieldDefinition,
  type IndonesianBusinessCredentials,
} from "../business-profile/index.ts";
import {
  getFormVerticalTemplate,
  type FormVerticalTemplate,
  type FormVerticalTemplateKey,
} from "../forms/templates.ts";
import { sanitizeRichTextHtml } from "../content/index.ts";
import type { OfferingType } from "../schemas/common.ts";
import {
  SECTION_REGISTRY_SCHEMA_VERSION,
  validatePageSections,
  type AnyValidatedPageSection,
  type ClosedSectionType,
  type PlatformThemeId,
  type SectionValidationWarning,
} from "../theme/index.ts";
import {
  normalizeIndonesianWhatsAppNumber,
  WhatsAppValidationError,
} from "../wa-dispatcher.ts";
import {
  computeSampleSectionIds,
  disableSampleSectionsForPageDraft,
  mergeStarterPresetDraftSections,
  SAMPLE_DRAFT_MARKER_LABEL,
  SAMPLE_MARKER_LABEL,
} from "./index.ts";

/**
 * Seven Zero-Guesswork B2B Vertical Conversion & SEO/AI Blueprints
 * (`packages/core/src/presets/blueprints.ts`; REQ-093, REQ-091, REQ-095,
 * PLAN §19.5 & §19.8, DESIGN.md §7, `04-b2b-conversion-blueprints.md`, TASK-093).
 *
 * Hard Invariants:
 * - Minimal 3-field onboarding (`businessName`, `blueprintId`, `whatsappPhone`)
 *   deterministically configures one of the 7 research-backed B2B conversion blueprints.
 * - Every starter section uses ONLY the closed unified section registry (`validatePageSections`).
 * - Zero *Lorem Ipsum*, zero fabricated reviews, zero fake logos/licences, zero unverified
 *   "Resmi"/"Terverifikasi" claims, zero fake seat-quota bars, and zero `ProfessionalService` output.
 * - Starter copy and 3 E-E-A-T draft blog outlines carry visible `CONTOH` / `[Contoh]` markers
 *   and NEVER auto-publish (`status: "draft"`, `autoPublish: false`).
 * - `regulated_professional` supports `medical_clinic`, `legal_notary`, and `tax_accounting`,
 *   seeds `testimonials` OFF with compliance/ethics warning, disables `AggregateRating`, and
 *   enables UU PDP sensitive-data notice on appointment forms.
 * - `personal_brand` and `sales_executive` emit Google `ProfilePage` (`mainEntity: Person`)
 *   JSON-LD linked via `@id` to `BlogPosting.author`.
 * - `travel_umrah_agency` emits structured Permenpar 6/2025 & Kemenag 5 Pasti Umrah fact sheets
 *   and provides render-time filtering of past departure dates (`Asia/Jakarta`).
 */

export const B2B_BLUEPRINT_IDS = [
  "b2b_corporate",
  "sales_executive",
  "personal_brand",
  "regulated_professional",
  "travel_umrah_agency",
  "offline_multibranch",
  "wa_catalog_showcase",
] as const;

export type B2BBlueprintId = (typeof B2B_BLUEPRINT_IDS)[number];

export const REGULATED_PROFESSIONAL_SUBTYPES = [
  "medical_clinic",
  "legal_notary",
  "tax_accounting",
] as const;

export type RegulatedProfessionalSubtype = (typeof REGULATED_PROFESSIONAL_SUBTYPES)[number];

export type BlueprintStarterFormId =
  | "b2b_rfq"
  | "test_drive_or_survey"
  | "speaking_or_consulting_invite"
  | "clinic_or_professional_appointment"
  | "tour_or_group_inquiry"
  | "branch_booking_or_catering"
  | "product_or_reseller_quote";

export interface BlueprintSidebarOfferingConfig {
  readonly primaryOfferingType: OfferingType;
  readonly primaryMenuLabel: string;
  readonly primaryRoutePath: "/layanan" | "/produk" | "/tour" | "/kendaraan";
  readonly hiddenOfferingTypes: readonly OfferingType[];
  readonly highlightBranchesMenu: boolean;
  readonly pricingDefaultModes: readonly ("fixed" | "from" | "range" | "on_request")[];
  readonly pricingNoteId: string;
}

export interface BlueprintDraftBlogOutline {
  readonly slug: string;
  readonly title: string;
  readonly focusKeywordHint: string;
  readonly eeatAngle: string;
  readonly outlinePoints: readonly string[];
  readonly status: "draft";
  readonly autoPublish: false;
  readonly sampleBadge: "CONTOH";
}

export interface BlueprintFactSheetItem {
  readonly label: string;
  readonly value: string;
  readonly isSample: boolean;
}

export interface BlueprintTourDepartureRow {
  readonly packageName: string;
  readonly departureDate: string; // YYYY-MM-DD (validated calendar date)
  readonly durationLabel: string;
  readonly airline: string;
  readonly hotelSummary: string;
  readonly priceIdrLabel: string;
}

export interface BlueprintLocalListingsCard {
  readonly title: string;
  readonly platforms: readonly ["Google Business Profile", "Bing Places"];
  readonly businessName: string;
  readonly categoryLabel: string;
  readonly address: string;
  readonly weekdayHours: string;
  readonly holidayHours: string;
  readonly phoneOrWhatsApp: string;
  readonly websiteUrl: string;
  readonly copyPlainText: string;
  readonly syncGuideNotes: readonly string[];
  readonly callsExternalApi: false;
}

export interface BlueprintDefinition {
  readonly id: B2BBlueprintId;
  readonly name: string;
  readonly targetSegment: string;
  readonly shortDescription: string;
  readonly defaultThemeId: PlatformThemeId;
  readonly alternateThemeId: PlatformThemeId | null;
  readonly defaultStyleVariant: string;
  readonly defaultBusinessCategory: ClosedBusinessCategoryKey;
  readonly schemaPrimaryType: string;
  readonly emitsProfilePageSchema: boolean;
  readonly testimonialsDefaultOff: boolean;
  readonly aggregateRatingDisabled: boolean;
  readonly requiresSensitiveDataNotice: boolean;
  readonly autoEnableFreePlugins: readonly string[];
  readonly sidebarOffering: BlueprintSidebarOfferingConfig;
  readonly sectionSequence: readonly ClosedSectionType[];
  readonly starterFormId: BlueprintStarterFormId;
  readonly formTemplateKey: FormVerticalTemplateKey;
  readonly whatsappMessageTemplate: string;
  readonly metaTitleTemplate: string;
  readonly metaDescriptionTemplate: string;
  readonly factSheetHeading: string;
  readonly factSheetFormat: "dl" | "table" | "dl_and_table";
  readonly credentialGuidanceNote: string;
  readonly draftBlogOutlines: readonly BlueprintDraftBlogOutline[];
}

const ALL_OFFERING_TYPES_ORDER: readonly OfferingType[] = [
  "service",
  "product",
  "tour",
  "vehicle",
];

function hiddenOfferingsFor(primary: OfferingType): readonly OfferingType[] {
  return ALL_OFFERING_TYPES_ORDER.filter((t) => t !== primary);
}

const REGULATED_SUBTYPE_META: Readonly<
  Record<
    RegulatedProfessionalSubtype,
    {
      readonly businessCategory: ClosedBusinessCategoryKey;
      readonly schemaPrimaryType: "MedicalClinic" | "LegalService" | "AccountingService";
      readonly ethicsNotice: string;
      readonly credentialPromptHint: string;
    }
  >
> = {
  medical_clinic: {
    businessCategory: "medical_clinic",
    schemaPrimaryType: "MedicalClinic",
    ethicsNotice:
      "Dinonaktifkan secara default sesuai ketentuan Permenkes 1787/2010 dan kode etik kedokteran/kesehatan.",
    credentialPromptHint:
      "Opsional: cantumkan nomor SIP/STR atau izin operasional klinik yang sah.",
  },
  legal_notary: {
    businessCategory: "legal_service",
    schemaPrimaryType: "LegalService",
    ethicsNotice:
      "Dinonaktifkan secara default sesuai Kode Etik Advokat dan ketentuan jabatan Notaris/PPAT.",
    credentialPromptHint:
      "Opsional: cantumkan nomor SK Kemenkumham, wilayah jabatan Notaris/PPAT, atau keanggotaan PERADI.",
  },
  tax_accounting: {
    businessCategory: "accounting_service",
    schemaPrimaryType: "AccountingService",
    ethicsNotice:
      "Dinonaktifkan secara default sesuai kode etik profesi Akuntan Publik dan Konsultan Pajak.",
    credentialPromptHint:
      "Opsional: cantumkan nomor izin Konsultan Pajak (KMK/IKPI) atau izin KAP/KJA.",
  },
};

export const B2B_VERTICAL_BLUEPRINTS: Readonly<Record<B2BBlueprintId, BlueprintDefinition>> = {
  b2b_corporate: {
    id: "b2b_corporate",
    name: "Perusahaan B2B, Manufaktur & Kontraktor",
    targetSegment: "Pabrik, Maklon (OEM/ODM), Distributor, Kontraktor B2B, Logistik",
    shortDescription:
      "Menonjolkan kapasitas produksi, MOQ, sertifikasi industri opsional (NIB/ISO/SNI/TKDN/BPOM/SBUJK), alur kerja 5 tahap, dan formulir permintaan penawaran (RFQ).",
    defaultThemeId: "compro",
    alternateThemeId: null,
    defaultStyleVariant: "bold-corporate",
    defaultBusinessCategory: "b2b_corporate",
    schemaPrimaryType: "Organization",
    emitsProfilePageSchema: false,
    testimonialsDefaultOff: false,
    aggregateRatingDisabled: false,
    requiresSensitiveDataNotice: false,
    autoEnableFreePlugins: [],
    sidebarOffering: {
      primaryOfferingType: "service",
      primaryMenuLabel: "Layanan",
      primaryRoutePath: "/layanan",
      hiddenOfferingTypes: hiddenOfferingsFor("service"),
      highlightBranchesMenu: false,
      pricingDefaultModes: ["on_request", "from"],
      pricingNoteId: "Gunakan mode Harga atas Permintaan atau Mulai dari beserta catatan unit/MOQ.",
    },
    sectionSequence: [
      "hero",
      "highlights",
      "trust_logos",
      "services_grid",
      "features",
      "about",
      "gallery",
      "faq",
      "custom_form",
      "contact_location",
    ],
    starterFormId: "b2b_rfq",
    formTemplateKey: "permintaan_penawaran",
    whatsappMessageTemplate:
      "Halo {nama_bisnis}, saya dari perusahaan ... ingin meminta penawaran terkait {judul_halaman}.",
    metaTitleTemplate: "{layanan_utama} — {nama_bisnis}{sertifikasi_suffix}",
    metaDescriptionTemplate:
      "{nama_bisnis} melayani {layanan_utama} untuk kebutuhan B2B di {kota}. Lihat spesifikasi, kapasitas, MOQ, dan ajukan penawaran melalui WhatsApp.",
    factSheetHeading: "Ringkasan Fakta Kapasitas & Standar Industri",
    factSheetFormat: "dl",
    credentialGuidanceNote:
      "Opsional: cantumkan NIB, ISO 9001/22716, SNI, TKDN, BPOM/CPKB, atau SBUJK yang benar-benar aktif.",
    draftBlogOutlines: [
      {
        slug: "standar-mutu-dan-proses-qc-fasilitas-kami",
        title: "CONTOH — Standar Mutu dan Proses QC di Fasilitas Kami",
        focusKeywordHint: "standar mutu qc manufaktur",
        eeatAngle: "Dokumentasi pengalaman operasional nyata dan tahapan inspeksi kualitas.",
        outlinePoints: [
          "Alur penerimaan bahan baku dan pemeriksaan spesifikasi awal",
          "Tahapan kendali mutu (QC) selama proses produksi atau pengerjaan proyek",
          "Dokumen serah terima dan standar pengemasan pengiriman B2B",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "panduan-spesifikasi-dan-moq-sebelum-memesan",
        title: "CONTOH — Panduan Spesifikasi dan MOQ Sebelum Memesan (OEM/ODM/Kontrak)",
        focusKeywordHint: "panduan moq oem odm b2b",
        eeatAngle: "Membantu tim procurement menyiapkan brief agar estimasi harga cepat dan akurat.",
        outlinePoints: [
          "Data spesifikasi teknis yang perlu disiapkan tim procurement",
          "Penjelasan minimal order (MOQ), estimasi lead time, dan tahap sample",
          "Skema kerja sama kontrak rutin dan penjadwalan pengiriman",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "studi-kasus-proyek-dan-pengiriman-b2b",
        title: "CONTOH — Studi Kasus Proyek dan Pengiriman B2B",
        focusKeywordHint: "studi kasus proyek b2b",
        eeatAngle: "Pembuktian kapabilitas dari proyek nyata yang disetujui untuk dipublikasikan.",
        outlinePoints: [
          "Tantangan teknis klien dan spesifikasi target awal",
          "Solusi produksi atau pengerjaan yang diterapkan tim",
          "Hasil terukur yang dapat diverifikasi tanpa klaim berlebihan",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
    ],
  },

  sales_executive: {
    id: "sales_executive",
    name: "Konsultan Penjualan (Otomotif, Properti, Asuransi)",
    targetSegment: "Konsultan Penjualan Dealer Mobil/Motor, Agen Properti, Agen Asuransi",
    shortDescription:
      "Dirancang untuk konsultan penjualan individu: informasi harga OTR wilayah, tabel estimasi kredit statis, 4 langkah serah terima, dan Galeri Serah Terima.",
    defaultThemeId: "sales",
    alternateThemeId: "dealer",
    defaultStyleVariant: "high-conversion",
    defaultBusinessCategory: "sales_executive",
    schemaPrimaryType: "ProfilePage",
    emitsProfilePageSchema: true,
    testimonialsDefaultOff: false,
    aggregateRatingDisabled: false,
    requiresSensitiveDataNotice: false,
    autoEnableFreePlugins: [],
    sidebarOffering: {
      primaryOfferingType: "vehicle",
      primaryMenuLabel: "Kendaraan",
      primaryRoutePath: "/kendaraan",
      hiddenOfferingTypes: hiddenOfferingsFor("vehicle"),
      highlightBranchesMenu: false,
      pricingDefaultModes: ["from", "fixed"],
      pricingNoteId:
        "Cantumkan harga OTR wilayah yang jelas beserta catatan bahwa estimasi kredit bersifat indikatif.",
    },
    sectionSequence: [
      "hero",
      "vehicles_grid",
      "about",
      "features",
      "gallery",
      "faq",
      "custom_form",
      "contact_location",
    ],
    starterFormId: "test_drive_or_survey",
    formTemplateKey: "test_drive",
    whatsappMessageTemplate:
      "Halo {nama_panggilan}, saya ingin info harga OTR & simulasi untuk {judul_halaman}.",
    metaTitleTemplate: "Harga OTR & Informasi {layanan_utama} {kota} — {nama_bisnis}{dealer_suffix}",
    metaDescriptionTemplate:
      "Informasi {layanan_utama} bersama {nama_bisnis}{dealer_suffix} untuk area {kota}. Cek daftar harga OTR, estimasi kredit statis, tukar tambah, dan jadwal test drive.",
    factSheetHeading: "Daftar Harga OTR Wilayah & Estimasi Kredit Statis",
    factSheetFormat: "dl_and_table",
    credentialGuidanceNote:
      "Opsional: sebutkan nama dealer/agensi naungan, alamat cabang, dan sertifikasi profesi (AREBI/AAJI bila ada).",
    draftBlogOutlines: [
      {
        slug: "daftar-harga-otr-dan-program-promo-bulan-ini",
        title: "CONTOH — Daftar Harga OTR dan Program Pembelian Bulan Ini di Wilayah Anda",
        focusKeywordHint: "harga otr terbaru",
        eeatAngle: "Transparansi harga OTR wilayah dan ketentuan pembiayaan sesuai brosur dealer.",
        outlinePoints: [
          "Ringkasan tipe unit populer dan kisaran OTR wilayah (isi angka terbaru)",
          "Perbedaan skema pembelian tunai, kredit, dan tukar tambah",
          "Cara menjadwalkan test drive di showroom atau kunjungan lokasi",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "perbandingan-varian-dan-fitur-untuk-keluarga",
        title: "CONTOH — Perbandingan Varian dan Fitur Utama untuk Kebutuhan Harian",
        focusKeywordHint: "perbandingan varian mobil keluarga",
        eeatAngle: "Perbandingan objektif antar varian agar pembeli memilih tipe yang tepat.",
        outlinePoints: [
          "Perbandingan fitur keselamatan dan kenyamanan tiap varian",
          "Pertimbangan kapasitas kabin, bagasi, dan biaya perawatan berkala",
          "Rekomendasi varian berdasarkan rute pemakaian dalam dan luar kota",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "syarat-kredit-dan-panduan-tukar-tambah-unit",
        title: "CONTOH — Syarat Pengajuan Kredit dan Panduan Tukar Tambah Unit Lama",
        focusKeywordHint: "syarat kredit dan tukar tambah",
        eeatAngle: "Langkah praktis dokumen dan taksasi agar proses serah terima lancar.",
        outlinePoints: [
          "Daftar dokumen standar perorangan dan perusahaan",
          "Alur inspeksi dan taksasi tukar tambah unit lama",
          "Disclaimer estimasi angsuran dan verifikasi langsung pihak pembiayaan",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
    ],
  },

  personal_brand: {
    id: "personal_brand",
    name: "Personal Brand, Pembicara & Konsultan",
    targetSegment: "Pembicara, Trainer Korporat, Coach, Konsultan Independen, Kreator",
    shortDescription:
      "Membangun profil keahlian personal dengan skema Google ProfilePage (Person) tertaut ke penulis artikel, daftar topik, media/YouTube, dan tautan bio gratis (/link).",
    defaultThemeId: "sales",
    alternateThemeId: "compro",
    defaultStyleVariant: "clean-editorial",
    defaultBusinessCategory: "personal_brand",
    schemaPrimaryType: "ProfilePage",
    emitsProfilePageSchema: true,
    testimonialsDefaultOff: false,
    aggregateRatingDisabled: false,
    requiresSensitiveDataNotice: false,
    autoEnableFreePlugins: ["bio-links"],
    sidebarOffering: {
      primaryOfferingType: "service",
      primaryMenuLabel: "Topik & Layanan",
      primaryRoutePath: "/layanan",
      hiddenOfferingTypes: hiddenOfferingsFor("service"),
      highlightBranchesMenu: false,
      pricingDefaultModes: ["on_request", "from"],
      pricingNoteId: "Gunakan Harga atas Permintaan atau Mulai dari untuk sesi keynote/in-house.",
    },
    sectionSequence: [
      "hero",
      "trust_logos",
      "services_grid",
      "about",
      "gallery",
      "testimonials",
      "faq",
      "custom_form",
      "contact_location",
    ],
    starterFormId: "speaking_or_consulting_invite",
    formTemplateKey: "booking_layanan",
    whatsappMessageTemplate:
      "Halo Tim {nama_bisnis}, kami ingin mengundang / berkonsultasi mengenai {judul_halaman}.",
    metaTitleTemplate: "{nama_bisnis} — {layanan_utama} | Profil & Topik",
    metaDescriptionTemplate:
      "Profil {nama_bisnis}. Pelajari bidang keahlian, topik pelatihan/konsultasi, publikasi, dan jadwalkan undangan acara atau in-house training.",
    factSheetHeading: "Profil Keahlian & Format Sesi",
    factSheetFormat: "dl",
    credentialGuidanceNote:
      "Opsional: cantumkan gelar akademik/profesi, sertifikasi BNSP/ICF, atau publikasi buku/ISBN.",
    draftBlogOutlines: [
      {
        slug: "kerangka-kerja-dan-metodologi-utama",
        title: "CONTOH — Kerangka Kerja dan Metodologi Utama yang Saya Bawakan",
        focusKeywordHint: "metodologi pelatihan korporat",
        eeatAngle: "Menunjukkan pemikiran orisinal dan kerangka kerja yang dapat diterapkan klien.",
        outlinePoints: [
          "Akar masalah yang sering ditemui pada tim atau organisasi",
          "Tiga pilar kerangka kerja yang digunakan dalam pendampingan",
          "Contoh penerapan praktis yang dapat dievaluasi setelah sesi",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "pelajaran-dari-mendampingi-organisasi-klien",
        title: "CONTOH — Pelajaran Penting dari Mendampingi Organisasi Klien",
        focusKeywordHint: "pengalaman pendampingan organisasi",
        eeatAngle: "Pengalaman langsung lapangan dengan menjaga kerahasiaan data klien.",
        outlinePoints: [
          "Pola keberhasilan implementasi di tim lintas fungsi",
          "Hambatan umum pasca-pelatihan dan cara mengatasinya",
          "Indikator tindak lanjut yang disepakati bersama manajemen",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "panduan-memilih-topik-pelatihan-untuk-tim",
        title: "CONTOH — Panduan Memilih Topik Pelatihan yang Tepat untuk Tim Anda",
        focusKeywordHint: "cara memilih topik in-house training",
        eeatAngle: "Membantu tim HR/panitia menyusun brief undangan yang terarah.",
        outlinePoints: [
          "Memetakan profil peserta dan tujuan bisnis acara",
          "Memilih format keynote, workshop setengah hari, atau pendampingan berkala",
          "Informasi jadwal dan teknis yang perlu disiapkan saat menghubungi tim",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
    ],
  },

  regulated_professional: {
    id: "regulated_professional",
    name: "Profesi Teregulasi (Klinik, Dokter, Hukum, Notaris, Pajak)",
    targetSegment: "Klinik Medis/Gigi, Dokter, Advokat/Firma Hukum, Notaris/PPAT, Akuntan/Pajak",
    shortDescription:
      "Nada informasional sesuai Permenkes & kode etik profesi: testimoni dan AggregateRating nonaktif otomatis, jadwal praktik terstruktur, dan formulir janji temu ramah UU PDP.",
    defaultThemeId: "compro",
    alternateThemeId: "sales",
    defaultStyleVariant: "informational-clean",
    defaultBusinessCategory: "medical_clinic",
    schemaPrimaryType: "MedicalClinic",
    emitsProfilePageSchema: false,
    testimonialsDefaultOff: true,
    aggregateRatingDisabled: true,
    requiresSensitiveDataNotice: true,
    autoEnableFreePlugins: [],
    sidebarOffering: {
      primaryOfferingType: "service",
      primaryMenuLabel: "Layanan",
      primaryRoutePath: "/layanan",
      hiddenOfferingTypes: hiddenOfferingsFor("service"),
      highlightBranchesMenu: false,
      pricingDefaultModes: ["from", "fixed", "on_request"],
      pricingNoteId:
        "Sajikan informasi prosedur secara objektif tanpa klaim hasil pasti atau testimoni pasien/klien.",
    },
    sectionSequence: [
      "hero",
      "about",
      "services_grid",
      "features",
      "testimonials",
      "blog_latest",
      "faq",
      "custom_form",
      "contact_location",
    ],
    starterFormId: "clinic_or_professional_appointment",
    formTemplateKey: "booking_layanan",
    whatsappMessageTemplate:
      "Halo {nama_bisnis}, saya ingin menjadwalkan janji temu / konsultasi untuk {judul_halaman}.",
    metaTitleTemplate: "{nama_bisnis} — {layanan_utama} di {kota}",
    metaDescriptionTemplate:
      "Informasi layanan {nama_bisnis} di {kota}: jadwal praktik, bidang layanan, nomor izin praktisi (opsional), dan prosedur pendaftaran janji temu.",
    factSheetHeading: "Jadwal Praktik, Wilayah Layanan & Informasi Izin",
    factSheetFormat: "table",
    credentialGuidanceNote:
      "Opsional: cantumkan nomor SIP/STR/Izin Klinik, SK Kemenkumham/Wilayah Jabatan Notaris-PPAT, atau KMK Konsultan Pajak.",
    draftBlogOutlines: [
      {
        slug: "panduan-prosedur-dan-dokumen-sebelum-janji-temu",
        title: "CONTOH — Panduan Prosedur dan Dokumen yang Perlu Disiapkan",
        focusKeywordHint: "prosedur pendaftaran janji temu",
        eeatAngle: "Informasi administratif yang jelas dan tidak meminta data sensitif di formulir publik.",
        outlinePoints: [
          "Alur pendaftaran janji temu dan konfirmasi jadwal",
          "Dokumen identitas atau rujukan dasar yang perlu dibawa saat kunjungan",
          "Kebijakan privasi dan kerahasiaan data pasien atau klien",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "edukasi-dasar-sesuai-bidang-praktik",
        title: "CONTOH — Penjelasan Edukatif Terbaru dari Praktisi Kami",
        focusKeywordHint: "edukasi praktisi kesehatan hukum",
        eeatAngle: "Artikel edukasi bernada informasional dengan nama penulis dan tanggal pembaruan jelas.",
        outlinePoints: [
          "Latar belakang topik edukasi berdasarkan standar profesi berlaku",
          "Hal-hal umum yang perlu diketahui masyarakat secara objektif",
          "Catatan bahwa informasi artikel bersifat edukatif, bukan pengganti konsultasi langsung",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "tanya-jawab-alur-konsultasi-dan-jam-layanan",
        title: "CONTOH — Tanya-Jawab Seputar Alur Konsultasi dan Jam Layanan",
        focusKeywordHint: "jam layanan dan alur konsultasi",
        eeatAngle: "Menjawab pertanyaan praktis secara faktual tanpa bahasa promosi berlebihan.",
        outlinePoints: [
          "Jadwal operasional reguler dan ketentuan perubahan jadwal",
          "Estimasi durasi sesi konsultasi awal",
          "Kontak pendaftaran untuk konfirmasi kehadiran",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
    ],
  },

  travel_umrah_agency: {
    id: "travel_umrah_agency",
    name: "Biro Travel & Umrah (PPIU/PIHK)",
    targetSegment: "Tour Operator, Biro Perjalanan Wisata & Penyelenggara Umrah",
    shortDescription:
      "Etalase biro perjalanan (BUKAN OTA/tiket): panduan transparansi 5 Pasti Umrah & Permenpar 6/2025, tabel jadwal keberangkatan aktif otomatis, rencana perjalanan, dan formulir minat paket.",
    defaultThemeId: "travel",
    alternateThemeId: null,
    defaultStyleVariant: "warm-heritage",
    defaultBusinessCategory: "travel_umrah_agency",
    schemaPrimaryType: "TravelAgency",
    emitsProfilePageSchema: false,
    testimonialsDefaultOff: false,
    aggregateRatingDisabled: false,
    requiresSensitiveDataNotice: false,
    autoEnableFreePlugins: [],
    sidebarOffering: {
      primaryOfferingType: "tour",
      primaryMenuLabel: "Paket Tur",
      primaryRoutePath: "/tour",
      hiddenOfferingTypes: hiddenOfferingsFor("tour"),
      highlightBranchesMenu: false,
      pricingDefaultModes: ["from", "fixed"],
      pricingNoteId:
        "Sajikan harga per pax, durasi (X Hari Y Malam), maskapai, hotel, serta rincian termasuk/tidak termasuk tanpa bar kuota palsu.",
    },
    sectionSequence: [
      "hero",
      "features",
      "tours_grid",
      "about",
      "gallery",
      "faq",
      "custom_form",
      "contact_location",
    ],
    starterFormId: "tour_or_group_inquiry",
    formTemplateKey: "pendaftaran_tur",
    whatsappMessageTemplate:
      "Halo {nama_bisnis}, saya tertarik dengan paket {judul_halaman}. Mohon info jadwal keberangkatan dan ketersediaan seat.",
    metaTitleTemplate: "Paket {layanan_utama} — {nama_bisnis} | Biro Perjalanan {kota}",
    metaDescriptionTemplate:
      "Jelajahi paket perjalanan dari {nama_bisnis}. Rincian durasi, maskapai, hotel, jadwal keberangkatan aktif, dan konsultasi langsung via WhatsApp.",
    factSheetHeading: "Fakta 5 Pasti & Standar Permenpar 6/2025 + Jadwal Keberangkatan Aktif",
    factSheetFormat: "dl_and_table",
    credentialGuidanceNote:
      "Wajib isi SK Kemenag PPIU/PIHK asli sebelum menampilkan klaim penyelenggaraan Umrah/Haji; tambahkan NIB (KBLI 79121) dan ASITA/IATA jika ada.",
    draftBlogOutlines: [
      {
        slug: "panduan-persiapan-keberangkatan-dan-perlengkapan",
        title: "CONTOH — Panduan Persiapan Keberangkatan dan Perlengkapan Wajib",
        focusKeywordHint: "persiapan keberangkatan tur umrah",
        eeatAngle: "Checklist praktis persiapan dokumen dan barang bawaan bagi calon peserta.",
        outlinePoints: [
          "Masa berlaku paspor, dokumen visa, dan ketentuan kesehatan terbaru",
          "Daftar perlengkapan utama sesuai musim di negara tujuan",
          "Jadwal manasik atau technical meeting sebelum hari keberangkatan",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "mengenal-fasilitas-hotel-maskapai-dan-rute",
        title: "CONTOH — Mengenal Fasilitas Hotel, Maskapai, dan Rute Perjalanan",
        focusKeywordHint: "fasilitas hotel dan maskapai paket perjalanan",
        eeatAngle: "Kejelasan standar akomodasi dan transportasi sesuai Permenpar 6/2025.",
        outlinePoints: [
          "Pilihan maskapai, rute langsung atau transit, dan ketentuan bagasi",
          "Lokasi hotel, jarak akses utama, dan jenis kamar",
          "Rincian biaya yang termasuk dan tidak termasuk dalam paket",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "cara-mengecek-izin-resmi-biro-perjalanan",
        title: "CONTOH — Cara Mengecek Izin Biro Perjalanan dan Rincian Biaya",
        focusKeywordHint: "cek izin ppiu biro perjalanan",
        eeatAngle: "Edukasi transparansi 5 Pasti dan verifikasi rekening perusahaan.",
        outlinePoints: [
          "Langkah pengecekan izin penyelenggara perjalanan pada kanal pemerintah",
          "Poin penting yang harus tercantum dalam rincian paket perjalanan",
          "Tips keamanan pembayaran melalui rekening berbadan hukum",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
    ],
  },

  offline_multibranch: {
    id: "offline_multibranch",
    name: "Usaha Offline, F&B & Multi-Cabang",
    targetSegment: "Restoran, Kafe, Katering, Bengkel, Salon, Kursus/LKP, Usaha Multi-Outlet",
    shortDescription:
      "Fokus pada lokasi terdekat, jam buka hari kerja & libur, direktori cabang dengan tautan Google Maps tanpa JS, etalase menu/layanan, dan reservasi cepat.",
    defaultThemeId: "resto",
    alternateThemeId: "compro",
    defaultStyleVariant: "warm-hospitality",
    defaultBusinessCategory: "restaurant",
    schemaPrimaryType: "FoodEstablishment",
    emitsProfilePageSchema: false,
    testimonialsDefaultOff: false,
    aggregateRatingDisabled: false,
    requiresSensitiveDataNotice: false,
    autoEnableFreePlugins: [],
    sidebarOffering: {
      primaryOfferingType: "product",
      primaryMenuLabel: "Produk",
      primaryRoutePath: "/produk",
      hiddenOfferingTypes: hiddenOfferingsFor("product"),
      highlightBranchesMenu: true,
      pricingDefaultModes: ["fixed", "from"],
      pricingNoteId:
        "Tampilkan harga menu atau paket layanan yang jelas beserta jam operasional setiap cabang.",
    },
    sectionSequence: [
      "hero",
      "products_grid",
      "branches",
      "about",
      "gallery",
      "faq",
      "custom_form",
      "contact_location",
    ],
    starterFormId: "branch_booking_or_catering",
    formTemplateKey: "reservasi_meja",
    whatsappMessageTemplate:
      "Halo {nama_bisnis}, saya ingin menanyakan / reservasi {judul_halaman}.",
    metaTitleTemplate: "{layanan_utama} di {kota} — {nama_bisnis}",
    metaDescriptionTemplate:
      "Kunjungi {nama_bisnis} di {kota}. Lihat daftar menu/layanan, jam buka harian dan hari libur, lokasi cabang, serta reservasi langsung via WhatsApp.",
    factSheetHeading: "Direktori Cabang, Jam Operasional & Status Sertifikasi",
    factSheetFormat: "table",
    credentialGuidanceNote:
      "Opsional: cantumkan Sertifikat Halal BPJPH, nomor P-IRT, NPSN/Izin LKP, atau NIB yang berlaku.",
    draftBlogOutlines: [
      {
        slug: "daftar-menu-dan-paket-favorit-terbaru",
        title: "CONTOH — Daftar Menu atau Paket Layanan Favorit dan Kisaran Biaya",
        focusKeywordHint: "daftar menu paket layanan",
        eeatAngle: "Keterbukaan menu/paket dan porsi agar pengunjung datang dengan ekspektasi tepat.",
        outlinePoints: [
          "Pilihan menu atau layanan unggulan untuk kunjungan reguler",
          "Opsi paket rombongan, katering, atau perawatan berkala",
          "Cara reservasi awal untuk akhir pekan dan hari libur",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "lokasi-cabang-dan-panduan-jam-kunjungan",
        title: "CONTOH — Lokasi Cabang, Area Parkir, dan Panduan Jam Kunjungan",
        focusKeywordHint: "lokasi cabang jam buka",
        eeatAngle: "Informasi akses lokal yang membantu pencarian dekat saya di Google & Bing.",
        outlinePoints: [
          "Patokan lokasi dan akses menuju setiap cabang",
          "Jam ramai dan waktu kunjungan paling nyaman",
          "Fasilitas yang tersedia di lokasi (parkir, ruang keluarga, musala)",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "tips-memilih-paket-dari-tim-kami",
        title: "CONTOH — Tips Memilih Paket atau Menu Sesuai Kebutuhan Acara",
        focusKeywordHint: "tips memilih paket acara catering",
        eeatAngle: "Panduan praktis langsung dari tim operasional berpengalaman.",
        outlinePoints: [
          "Menyesuaikan pilihan paket dengan jumlah tamu atau kondisi kebutuhan",
          "Batas waktu pemesanan awal dan konfirmasi perubahan jumlah",
          "Pertanyaan yang paling sering diajukan sebelum berkunjung",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
    ],
  },

  wa_catalog_showcase: {
    id: "wa_catalog_showcase",
    name: "Katalog Produk UMKM & Grosir via WhatsApp",
    targetSegment: "Brand Produk UMKM, Mebel/Kerajinan, Konveksi, Katalog Grosir & Reseller",
    shortDescription:
      "Etalase katalog rapi tanpa keranjang rumit: harga tetap/rentang grosir/nego, tabel spesifikasi material & MOQ, panduan kirim, dan tombol WhatsApp kontekstual per produk.",
    defaultThemeId: "catalog",
    alternateThemeId: null,
    defaultStyleVariant: "clean-modern",
    defaultBusinessCategory: "retail_store",
    schemaPrimaryType: "Store",
    emitsProfilePageSchema: false,
    testimonialsDefaultOff: false,
    aggregateRatingDisabled: false,
    requiresSensitiveDataNotice: false,
    autoEnableFreePlugins: [],
    sidebarOffering: {
      primaryOfferingType: "product",
      primaryMenuLabel: "Produk",
      primaryRoutePath: "/produk",
      hiddenOfferingTypes: hiddenOfferingsFor("product"),
      highlightBranchesMenu: false,
      pricingDefaultModes: ["fixed", "range", "on_request"],
      pricingNoteId:
        "Gunakan harga tetap, rentang grosir, atau harga atas permintaan; tersedia penanda Nego serta Ready/Pre-Order.",
    },
    sectionSequence: [
      "hero",
      "products_grid",
      "about",
      "features",
      "gallery",
      "faq",
      "custom_form",
      "contact_location",
    ],
    starterFormId: "product_or_reseller_quote",
    formTemplateKey: "permintaan_penawaran",
    whatsappMessageTemplate:
      "Halo {nama_bisnis}, saya tertarik dengan produk {judul_halaman}. Apakah stok tersedia?",
    metaTitleTemplate: "{layanan_utama} — {nama_bisnis} | Katalog Produk {kota}",
    metaDescriptionTemplate:
      "Lihat katalog {layanan_utama} dari {nama_bisnis} ({kota}). Spesifikasi material, opsi ecer/grosir, dan pemesanan langsung via WhatsApp.",
    factSheetHeading: "Tabel Spesifikasi Produk, Minimal Pesanan & Pengiriman",
    factSheetFormat: "dl",
    credentialGuidanceNote:
      "Opsional: cantumkan NIB, Halal BPJPH, P-IRT, atau keterangan nama rekening usaha untuk keamanan transaksi.",
    draftBlogOutlines: [
      {
        slug: "cara-membedakan-kualitas-material-produk",
        title: "CONTOH — Cara Membedakan Kualitas Material Produk Sebelum Membeli",
        focusKeywordHint: "cara cek kualitas material produk",
        eeatAngle: "Edukasi bahan baku dan finishing agar pembeli memahami nilai produk.",
        outlinePoints: [
          "Ciri material utama yang tahan lama untuk pemakaian harian",
          "Perbedaan finishing standar dan custom pesanan",
          "Tips perawatan sederhana agar produk tetap awet",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "panduan-pemesanan-ecer-custom-dan-grosir",
        title: "CONTOH — Panduan Pemesanan Ecer, Custom, dan Grosir via WhatsApp",
        focusKeywordHint: "panduan order grosir reseller",
        eeatAngle: "Menjelaskan alur pemesanan tanpa keranjang belanja agar transaksi WA lancar.",
        outlinePoints: [
          "Cara menanyakan ketersediaan stok ready atau estimasi pre-order",
          "Ketentuan minimal order grosir dan potongan harga reseller",
          "Verifikasi nama rekening usaha sebelum melakukan transfer",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
      {
        slug: "proses-pengemasan-aman-pengiriman-luar-kota",
        title: "CONTOH — Proses Pengemasan Aman untuk Pengiriman Luar Kota dan Pulau",
        focusKeywordHint: "pengemasan pengiriman luar kota",
        eeatAngle: "Menjawab kekhawatiran pembeli luar daerah mengenai keamanan ekspedisi.",
        outlinePoints: [
          "Standar pengemasan kardus, pelindung sudut, atau peti kayu bila perlu",
          "Pilihan ekspedisi kargo darat, laut, maupun udara",
          "Dokumentasi foto sebelum barang diserahkan ke kurir",
        ],
        status: "draft",
        autoPublish: false,
        sampleBadge: "CONTOH",
      },
    ],
  },
};

export const B2B_BLUEPRINT_CATALOG: readonly BlueprintDefinition[] = B2B_BLUEPRINT_IDS.map(
  (id) => B2B_VERTICAL_BLUEPRINTS[id],
);

export function getB2BBlueprint(id: string): BlueprintDefinition | null {
  const normalized = id.trim().toLowerCase();
  if ((B2B_BLUEPRINT_IDS as readonly string[]).includes(normalized)) {
    return B2B_VERTICAL_BLUEPRINTS[normalized as B2BBlueprintId];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strict Validators: HTTPS-Only Canonical Origin & Real Calendar Dates
// ---------------------------------------------------------------------------

/**
 * Validates that a `YYYY-MM-DD` string represents a real Gregorian calendar date
 * (rejects `"2026-99-99"`, `"2026-02-30"`, `"2025-02-29"`).
 */
export function isValidIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Strict HTTPS-only canonical origin validator.
 * Rejects `javascript:`, `data:`, `ftp:`, `http://`, embedded credentials,
 * non-root paths, query strings, and hash fragments; normalizes to `parsed.origin`.
 */
export const SafeCanonicalOriginSchema = z
  .string()
  .trim()
  .min(10, "Canonical origin harus berupa URL https:// yang valid")
  .max(255, "Canonical origin maksimal 255 karakter")
  .superRefine((val, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(val);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Canonical origin bukan URL yang valid",
      });
      return;
    }
    if (parsed.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        message: "Canonical origin wajib menggunakan protokol https://",
      });
      return;
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: "custom",
        message: "Canonical origin tidak boleh memuat kredensial",
      });
      return;
    }
    if (!parsed.hostname || !parsed.hostname.includes(".")) {
      ctx.addIssue({
        code: "custom",
        message: "Canonical origin wajib memiliki hostname domain yang valid",
      });
      return;
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      ctx.addIssue({
        code: "custom",
        message: "Canonical origin tidak boleh memuat path, query, atau fragmen",
      });
    }
  })
  .transform((val) => new URL(val).origin);

const IsoCalendarDateSchema = z
  .string()
  .trim()
  .refine(isValidIsoCalendarDate, {
    message: "Tanggal keberangkatan harus berupa tanggal kalender YYYY-MM-DD yang valid",
  });

// ---------------------------------------------------------------------------
// Minimal 3-Field Onboarding Input Schema (REQ-093)
// ---------------------------------------------------------------------------

export const MinimalOnboardingInputSchema = z
  .object({
    businessName: z
      .string()
      .trim()
      .min(2, "Nama usaha atau nama personal minimal 2 karakter")
      .max(120, "Nama usaha maksimal 120 karakter"),
    blueprintId: z.enum(B2B_BLUEPRINT_IDS),
    whatsappPhone: z
      .string()
      .trim()
      .min(8, "Nomor WhatsApp minimal 8 digit")
      .max(25, "Nomor WhatsApp maksimal 25 karakter")
      .superRefine((val, ctx) => {
        try {
          normalizeIndonesianWhatsAppNumber(val);
        } catch (err) {
          ctx.addIssue({
            code: "custom",
            message:
              err instanceof WhatsAppValidationError
                ? err.message
                : "Format nomor WhatsApp Indonesia tidak valid",
          });
        }
      })
      .transform((val) => normalizeIndonesianWhatsAppNumber(val)),
    regulatedSubtype: z.enum(REGULATED_PROFESSIONAL_SUBTYPES).optional(),
    city: z.string().trim().max(80).optional(),
    address: z.string().trim().max(300).optional(),
    weekdayHours: z.string().trim().max(160).optional(),
    holidayHours: z.string().trim().max(160).optional(),
    primaryOfferingTitle: z.string().trim().max(80).optional(),
    affiliatedDealerName: z.string().trim().max(120).optional(),
    handle: z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/)
      .optional(),
    canonicalOrigin: SafeCanonicalOriginSchema.optional(),
    credentials: z
      .object({
        nib: z.string().trim().max(20).optional(),
        isoSniTkdn: z.string().trim().max(80).optional(),
        skKemenagPpiu: z.string().trim().max(80).optional(),
        asitaIata: z.string().trim().max(48).optional(),
        sipStr: z.string().trim().max(64).optional(),
        barNotaryJurisdiction: z.string().trim().max(100).optional(),
        halalBpjh: z.string().trim().max(32).optional(),
        pirt: z.string().trim().max(36).optional(),
        lkpNpsn: z.string().trim().max(64).optional(),
      })
      .strict()
      .optional(),
    tourDepartures: z
      .array(
        z
          .object({
            packageName: z.string().trim().min(1).max(120),
            departureDate: IsoCalendarDateSchema,
            durationLabel: z.string().trim().min(1).max(40),
            airline: z.string().trim().min(1).max(80),
            hotelSummary: z.string().trim().min(1).max(120),
            priceIdrLabel: z.string().trim().min(1).max(60),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

export type MinimalOnboardingInput = z.input<typeof MinimalOnboardingInputSchema>;
export type ValidatedMinimalOnboardingInput = z.infer<typeof MinimalOnboardingInputSchema>;

export interface ApplyVerticalBlueprintOptions {
  /** Server-supplied reference clock (NEVER accepted from untrusted client payloads). */
  readonly now?: Date | string;
}

// ---------------------------------------------------------------------------
// Render-Time Past Departure Date Filter (REQ-093, REQ-095)
// ---------------------------------------------------------------------------

function resolveTodayJakartaIso(now: Date | string = new Date()): string {
  const refDate = typeof now === "string" ? new Date(now) : now;
  const effectiveNow = Number.isNaN(refDate.getTime()) ? new Date() : refDate;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(effectiveNow);
}

/**
 * Filters out past tour/Umrah departure dates (`departureDate < todayJakarta`)
 * AND rejects invalid calendar dates so public HTML tables and Schema.org never
 * cite expired or malformed schedules.
 */
export function filterActiveTourDepartures(
  departures: readonly BlueprintTourDepartureRow[],
  now: Date | string = new Date(),
): readonly BlueprintTourDepartureRow[] {
  const todayJakarta = resolveTodayJakartaIso(now);
  return departures.filter(
    (row) => isValidIsoCalendarDate(row.departureDate) && row.departureDate >= todayJakarta,
  );
}

/**
 * Alias explicitly used by public Astro renderers at request/render time to ensure
 * expired departure schedules disappear automatically as dates pass.
 */
export const filterExpiredTourDeparturesAtRender = filterActiveTourDepartures;

/**
 * Strips any `<tr>...</tr>` containing a past `YYYY-MM-DD` date (`< todayJakarta`)
 * inside `about`/`rich_text` section HTML at render time so previously saved tour
 * departure tables never display expired dates to visitors or crawlers.
 */
export function filterExpiredTourDeparturesInSectionsAtRender<
  T extends { readonly type?: string; readonly config?: Record<string, unknown> },
>(sections: readonly T[], now: Date | string = new Date()): readonly T[] {
  const todayJakarta = resolveTodayJakartaIso(now);
  const trRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
  const isoDateRe = /\b(\d{4}-\d{2}-\d{2})\b/g;

  return sections.map((section) => {
    if (
      (section.type !== "about" && section.type !== "rich_text") ||
      !section.config ||
      typeof section.config.bodyHtml !== "string"
    ) {
      return section;
    }

    const bodyHtml = section.config.bodyHtml;
    const filteredHtml = bodyHtml.replace(trRe, (rowHtml) => {
      let hasExpiredDate = false;
      isoDateRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = isoDateRe.exec(rowHtml)) !== null) {
        const candidate = match[1];
        if (candidate && isValidIsoCalendarDate(candidate) && candidate < todayJakarta) {
          hasExpiredDate = true;
          break;
        }
      }
      return hasExpiredDate ? "" : rowHtml;
    });

    if (filteredHtml === bodyHtml) {
      return section;
    }
    return {
      ...section,
      config: {
        ...section.config,
        bodyHtml: filteredHtml,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Semantic HTML AI Fact-Sheet & ProfilePage Schema Builders
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDefinitionListHtml(rows: readonly BlueprintFactSheetItem[]): string {
  const inner = rows
    .map(
      (row) =>
        `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`,
    )
    .join("");
  return `<dl>${inner}</dl>`;
}

function renderKeyValueTableHtml(rows: readonly BlueprintFactSheetItem[]): string {
  const tbody = rows
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th scope="col">Fakta Utama</th><th scope="col">Keterangan</th></tr></thead><tbody>${tbody}</tbody></table>`;
}

function renderTableHtml(
  caption: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const heading = `<h3>${escapeHtml(caption)}</h3>`;
  const thead = `<thead><tr>${headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `${heading}<table>${thead}${tbody}</table>`;
}

function buildFactSheetHtml(
  blueprint: BlueprintDefinition,
  input: ValidatedMinimalOnboardingInput,
  now: Date | string,
): {
  readonly html: string;
  readonly dlHtml: string;
  readonly items: readonly BlueprintFactSheetItem[];
} {
  const city = input.city || "[Contoh] Kota / Wilayah Layanan";
  const dealer = input.affiliatedDealerName || "[Contoh] Nama Dealer / Agensi Naungan";
  const hasPpiu = Boolean(input.credentials?.skKemenagPpiu);

  switch (blueprint.id) {
    case "b2b_corporate": {
      const items: BlueprintFactSheetItem[] = [
        { label: "Tahun Berdiri", value: "[Contoh] Isi tahun berdiri perusahaan", isSample: true },
        { label: "Kapasitas Produksi / Layanan", value: "[Contoh] Isi kapasitas bulanan/proyek terverifikasi", isSample: true },
        { label: "MOQ / Batch Minimum", value: "[Contoh] Isi minimal order atau nilai proyek", isSample: true },
        { label: "Estimasi Lead Time", value: "[Contoh] Isi estimasi waktu produksi/pengiriman", isSample: true },
        {
          label: "Sertifikasi & Legalitas",
          value:
            input.credentials?.isoSniTkdn ||
            input.credentials?.nib ||
            "[Contoh] Opsional: isi NIB, ISO, SNI, TKDN, BPOM, atau SBUJK asli",
          isSample: !(input.credentials?.isoSniTkdn || input.credentials?.nib),
        },
        { label: "Area Pengiriman / Layanan", value: city, isSample: !input.city },
      ];
      return {
        html: sanitizeRichTextHtml(renderKeyValueTableHtml(items)),
        dlHtml: renderDefinitionListHtml(items),
        items,
      };
    }

    case "sales_executive": {
      const items: BlueprintFactSheetItem[] = [
        { label: "Konsultan Penjualan", value: input.businessName, isSample: false },
        { label: "Dealer / Agensi Naungan", value: dealer, isSample: !input.affiliatedDealerName },
        { label: "Wilayah OTR", value: city, isSample: !input.city },
        {
          label: "Layanan Pembelian",
          value: "[Contoh] Test Drive ke Rumah/Showroom, Pembelian Tunai/Kredit, Tukar Tambah",
          isSample: true,
        },
      ];
      const otrTable = renderTableHtml(
        "Contoh Tabel Harga OTR Wilayah & Estimasi Kredit Statis",
        ["Model / Varian", "Harga OTR Wilayah", "Estimasi DP", "Catatan"],
        [
          [
            "[Contoh] Tipe Varian A",
            "[Contoh] Isi harga OTR wilayah",
            "[Contoh] Mulai 20%",
            "Estimasi indikatif, bukan penawaran mengikat",
          ],
          [
            "[Contoh] Tipe Varian B",
            "[Contoh] Isi harga OTR wilayah",
            "[Contoh] Mulai 20%",
            "Verifikasi akhir oleh pihak pembiayaan",
          ],
        ],
      );
      return {
        html: sanitizeRichTextHtml(`${renderKeyValueTableHtml(items)}${otrTable}`),
        dlHtml: renderDefinitionListHtml(items),
        items,
      };
    }

    case "personal_brand": {
      const items: BlueprintFactSheetItem[] = [
        { label: "Nama & Gelar", value: input.businessName, isSample: false },
        { label: "Bidang Keahlian", value: "[Contoh] Kepemimpinan, Strategi B2B, atau Bidang Anda", isSample: true },
        { label: "Topik Utama", value: "[Contoh] Isi 2–3 topik keynote atau workshop", isSample: true },
        {
          label: "Format Sesi",
          value: "[Contoh] In-House Training, Keynote Speaker, Konsultasi, Daring/Luring",
          isSample: true,
        },
        { label: "Skala Peserta", value: "[Contoh] Isi rentang jumlah peserta yang biasa ditangani", isSample: true },
        { label: "Domisili & Cakupan", value: city, isSample: !input.city },
      ];
      return {
        html: sanitizeRichTextHtml(renderKeyValueTableHtml(items)),
        dlHtml: renderDefinitionListHtml(items),
        items,
      };
    }

    case "regulated_professional": {
      const subtype: RegulatedProfessionalSubtype = input.regulatedSubtype ?? "medical_clinic";
      const permitValue =
        input.credentials?.sipStr ||
        input.credentials?.barNotaryJurisdiction ||
        (subtype === "medical_clinic"
          ? "[Contoh] Opsional: isi nomor SIP/STR atau izin operasional klinik asli"
          : subtype === "legal_notary"
            ? "[Contoh] Opsional: isi nomor SK Kemenkumham/wilayah jabatan Notaris-PPAT atau NIA PERADI"
            : "[Contoh] Opsional: isi nomor izin Konsultan Pajak (KMK/IKPI) atau KAP/KJA");
      const items: BlueprintFactSheetItem[] = [
        { label: "Nama Praktik / Kantor", value: input.businessName, isSample: false },
        { label: "Wilayah Layanan / Jabatan", value: city, isSample: !input.city },
        {
          label: "Nomor Izin Praktik",
          value: permitValue,
          isSample: !(input.credentials?.sipStr || input.credentials?.barNotaryJurisdiction),
        },
        {
          label: "Catatan Privasi (UU PDP)",
          value:
            "Jangan kirimkan keluhan medis sensitif atau rahasia perkara pada formulir publik.",
          isSample: false,
        },
      ];
      const scheduleTable = renderTableHtml(
        "Jadwal Praktik & Prosedur Janji Temu",
        ["Hari", "Sesi Layanan", "Prosedur Pendaftaran"],
        [
          ["Senin – Jumat", "[Contoh] 09.00 – 17.00 WIB", "Pendaftaran melalui WhatsApp atau formulir janji temu"],
          ["Sabtu", "[Contoh] 09.00 – 13.00 WIB", "Konfirmasi ketersediaan jadwal terlebih dahulu"],
        ],
      );
      return {
        html: sanitizeRichTextHtml(`${renderKeyValueTableHtml(items)}${scheduleTable}`),
        dlHtml: renderDefinitionListHtml(items),
        items,
      };
    }

    case "travel_umrah_agency": {
      const activeDepartures = filterActiveTourDepartures(input.tourDepartures ?? [], now);
      const permitText = hasPpiu
        ? `SK Kemenag PPIU/PIHK: ${input.credentials?.skKemenagPpiu}`
        : "[Contoh] Isi SK Kemenag PPIU/PIHK jika menyelenggarakan Umrah (kosongkan bila hanya tur wisata umum)";
      const items: BlueprintFactSheetItem[] = [
        { label: "1. Pasti Berizin (PPIU / NIB)", value: permitText, isSample: !hasPpiu },
        { label: "2. Pasti Jadwal & Maskapai", value: "[Contoh] Maskapai dan jadwal dikonfirmasi sebelum keberangkatan", isSample: true },
        { label: "3. Pasti Harga & Layanan (Permenpar 6/2025)", value: "[Contoh] Rincian harga per pax, termasuk & tidak termasuk ditulis terbuka", isSample: true },
        { label: "4. Pasti Akomodasi / Hotel", value: "[Contoh] Nama hotel, kelas bintang, dan lokasi dijelaskan di tiap paket", isSample: true },
        { label: "5. Pasti Visa & Asuransi Perjalanan", value: "[Contoh] Visa dan perlindungan asuransi sesuai rincian paket", isSample: true },
      ];
      const departureRows: (readonly string[])[] =
        activeDepartures.length > 0
          ? activeDepartures.map((d) => [
              d.packageName,
              d.departureDate,
              d.durationLabel,
              d.airline,
              d.hotelSummary,
              d.priceIdrLabel,
            ])
          : [
              [
                hasPpiu ? "[Contoh] Paket Umrah Reguler 9 Hari" : "[Contoh] Paket Wisata Domestik 3H2M",
                "[Contoh] Isi tanggal berangkat aktif",
                "[Contoh] 3 Hari 2 Malam",
                "[Contoh] Nama maskapai",
                "[Contoh] Nama hotel",
                "[Contoh] Mulai Rp ...",
              ],
            ];
      const departureTable = renderTableHtml(
        "Tabel Jadwal Keberangkatan Aktif",
        ["Paket", "Tanggal Berangkat", "Durasi", "Maskapai", "Hotel", "Harga/Pax"],
        departureRows,
      );
      return {
        html: sanitizeRichTextHtml(`${renderKeyValueTableHtml(items)}${departureTable}`),
        dlHtml: renderDefinitionListHtml(items),
        items,
      };
    }

    case "offline_multibranch": {
      const halalText =
        input.credentials?.halalBpjh ||
        input.credentials?.pirt ||
        input.credentials?.lkpNpsn ||
        "[Contoh] Opsional: isi Sertifikat Halal BPJPH, P-IRT, atau Izin LKP asli";
      const items: BlueprintFactSheetItem[] = [
        { label: "Nama Usaha", value: input.businessName, isSample: false },
        { label: "Kota Utama", value: city, isSample: !input.city },
        {
          label: "Sertifikasi / Izin",
          value: halalText,
          isSample: !(
            input.credentials?.halalBpjh ||
            input.credentials?.pirt ||
            input.credentials?.lkpNpsn
          ),
        },
      ];
      const branchTable = renderTableHtml(
        "Direktori Cabang & Jam Operasional",
        ["Cabang", "Alamat", "Jam Hari Kerja", "Jam Hari Libur"],
        [
          [
            `${input.businessName} — Utama`,
            `[Contoh] Isi alamat lengkap cabang utama (${city})`,
            "[Contoh] Senin–Jumat 09.00–21.00 WIB",
            "[Contoh] Sabtu–Minggu 10.00–22.00 WIB",
          ],
        ],
      );
      return {
        html: sanitizeRichTextHtml(`${renderKeyValueTableHtml(items)}${branchTable}`),
        dlHtml: renderDefinitionListHtml(items),
        items,
      };
    }

    case "wa_catalog_showcase": {
      const items: BlueprintFactSheetItem[] = [
        { label: "Bahan / Material Utama", value: "[Contoh] Isi jenis bahan/material produk Anda", isSample: true },
        { label: "Ukuran / Dimensi", value: "[Contoh] Isi opsi ukuran standar atau custom", isSample: true },
        { label: "Minimal Pesanan (MOQ)", value: "[Contoh] Ecer mulai 1 pcs / Grosir mulai 12 pcs", isSample: true },
        { label: "Status Ketersediaan", value: "[Contoh] Ready Stock / Pre-Order (isi estimasi hari)", isSample: true },
        { label: "Kota Pengiriman", value: city, isSample: !input.city },
        {
          label: "Keamanan Pembayaran",
          value: `[Contoh] Transfer hanya ke rekening atas nama ${input.businessName}.`,
          isSample: true,
        },
      ];
      return {
        html: sanitizeRichTextHtml(renderKeyValueTableHtml(items)),
        dlHtml: renderDefinitionListHtml(items),
        items,
      };
    }
  }
}

export interface ProfilePageSchemaGraph {
  readonly "@context": "https://schema.org";
  readonly "@graph": readonly Record<string, unknown>[];
}

/**
 * Builds Google-compliant `ProfilePage` (`mainEntity: Person`) JSON-LD linked
 * via `@id` (`#person`) to `BlogPosting.author` for `personal_brand` and `sales_executive`
 * (`REQ-093`, `PLAN §19.8`, `04-b2b-conversion-blueprints.md` SRC-101).
 */
export function buildBlueprintProfilePageSchema(params: {
  readonly blueprintId: B2BBlueprintId;
  readonly personName: string;
  readonly canonicalOrigin: string;
  readonly jobTitle?: string;
  readonly affiliatedOrganizationName?: string;
  readonly areaServed?: string;
  readonly sameAs?: readonly string[];
  readonly sampleBlogPostSlug?: string;
  readonly sampleBlogPostHeadline?: string;
}): ProfilePageSchemaGraph | null {
  if (params.blueprintId !== "personal_brand" && params.blueprintId !== "sales_executive") {
    return null;
  }

  const origin = SafeCanonicalOriginSchema.parse(params.canonicalOrigin);
  const personId = `${origin}/#person`;
  const profilePageId = `${origin}/#profilepage`;
  const orgId = `${origin}/#affiliated-org`;

  const personNode: Record<string, unknown> = {
    "@type": "Person",
    "@id": personId,
    name: params.personName.trim(),
    url: `${origin}/`,
    jobTitle:
      params.jobTitle ??
      (params.blueprintId === "sales_executive"
        ? "Konsultan Penjualan"
        : "Pembicara & Konsultan"),
    ...(params.areaServed ? { areaServed: params.areaServed } : {}),
    ...(params.sameAs && params.sameAs.length > 0 ? { sameAs: [...params.sameAs] } : {}),
  };

  const graph: Record<string, unknown>[] = [];

  if (
    params.blueprintId === "sales_executive" &&
    params.affiliatedOrganizationName?.trim()
  ) {
    personNode.worksFor = { "@id": orgId };
    graph.push({
      "@type": "AutoDealer",
      "@id": orgId,
      name: params.affiliatedOrganizationName.trim(),
    });
  }

  graph.push(
    {
      "@type": "ProfilePage",
      "@id": profilePageId,
      url: `${origin}/`,
      name: params.personName.trim(),
      mainEntity: { "@id": personId },
    },
    personNode,
  );

  if (params.sampleBlogPostSlug && params.sampleBlogPostHeadline) {
    graph.push({
      "@type": "BlogPosting",
      "@id": `${origin}/blog/${params.sampleBlogPostSlug}#article`,
      url: `${origin}/blog/${params.sampleBlogPostSlug}`,
      headline: params.sampleBlogPostHeadline,
      author: { "@id": personId },
    });
  }

  return {
    "@context": "https://schema.org",
    "@graph": graph,
  };
}

// ---------------------------------------------------------------------------
// Local Listings Copy Card Builder (Google Business Profile + Bing Places)
// ---------------------------------------------------------------------------

const UNFILLED_PROFILE_PLACEHOLDER = "(Belum diisi — lengkapi di Profil Bisnis)" as const;

export function buildDualLocalListingsCopyCard(params: {
  readonly businessName: string;
  readonly categoryLabel: string;
  readonly address?: string | null;
  readonly weekdayHours?: string | null;
  readonly holidayHours?: string | null;
  readonly whatsappE164?: string | null;
  readonly phone?: string | null;
  readonly websiteUrl: string;
}): BlueprintLocalListingsCard {
  const businessName = params.businessName.trim() || UNFILLED_PROFILE_PLACEHOLDER;
  const categoryLabel = params.categoryLabel.trim() || "Usaha Lokal";
  const rawAddress = params.address?.trim() || "";
  const rawWeekdayHours = params.weekdayHours?.trim() || "";
  const rawHolidayHours = params.holidayHours?.trim() || "";
  const rawPhoneOrWhatsApp =
    params.whatsappE164?.trim() || params.phone?.trim() || "";
  const websiteUrl = params.websiteUrl.trim();

  // Only include genuinely provided fields in `copyPlainText` — never fabricate hours or addresses!
  const copyLines: string[] = [
    `Nama Usaha: ${businessName}`,
    `Kategori: ${categoryLabel}`,
  ];
  if (rawAddress) copyLines.push(`Alamat: ${rawAddress}`);
  if (rawWeekdayHours) copyLines.push(`Jam Hari Kerja: ${rawWeekdayHours}`);
  if (rawHolidayHours) copyLines.push(`Jam Akhir Pekan / Libur: ${rawHolidayHours}`);
  if (rawPhoneOrWhatsApp) copyLines.push(`Telepon / WhatsApp: ${rawPhoneOrWhatsApp}`);
  if (websiteUrl) copyLines.push(`Situs: ${websiteUrl}`);

  return {
    title: "Samakan dengan Google Business Profile & Bing Places",
    platforms: ["Google Business Profile", "Bing Places"],
    businessName,
    categoryLabel,
    address: rawAddress || UNFILLED_PROFILE_PLACEHOLDER,
    weekdayHours: rawWeekdayHours || UNFILLED_PROFILE_PLACEHOLDER,
    holidayHours: rawHolidayHours || UNFILLED_PROFILE_PLACEHOLDER,
    phoneOrWhatsApp: rawPhoneOrWhatsApp || UNFILLED_PROFILE_PLACEHOLDER,
    websiteUrl,
    copyPlainText: copyLines.join("\n"),
    syncGuideNotes: [
      "Salin data Nama, Alamat, Telepon (NAP) dan jam buka di atas agar identik pada Google Business Profile dan Bing Places.",
      "Konsistensi data di Bing Places membantu asisten AI berbasis Bing/Copilot membaca alamat dan jam buka usaha Anda dengan akurat.",
      "Salin manual tanpa koneksi API pihak ketiga; pembaruan tidak pernah memicu klaim peringkat otomatis.",
    ],
    callsExternalApi: false,
  };
}

// ---------------------------------------------------------------------------
// Blueprint Section Builder & Full Application Result
// ---------------------------------------------------------------------------

function formatTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_match, key: string) => vars[key] ?? "");
}

function buildBlueprintRawSections(
  blueprint: BlueprintDefinition,
  input: ValidatedMinimalOnboardingInput,
  factSheetHtml: string,
  waHref: string,
  ethicsNoticeOverride: string | null,
): unknown[] {
  const cleanName = input.businessName;
  const city = input.city || "Indonesia";
  const offeringTitle = input.primaryOfferingTitle || blueprint.sidebarOffering.primaryMenuLabel;
  const formTemplate = getFormVerticalTemplate(blueprint.formTemplateKey);
  const formSlug = formTemplate?.defaultSlug ?? "kontak-umum";
  const hasPpiu = Boolean(input.credentials?.skKemenagPpiu);

  const sections: unknown[] = [];
  let order = 0;

  for (const type of blueprint.sectionSequence) {
    const id = `bp-${blueprint.id.replace(/_/g, "-")}-${type.replace(/_/g, "-")}`;

    switch (type) {
      case "hero": {
        const heroCopyByBlueprint: Record<
          B2BBlueprintId,
          { eyebrow: string; heading: string; subheading: string; ctaLabel: string }
        > = {
          b2b_corporate: {
            eyebrow: `${SAMPLE_MARKER_LABEL} Mitra Industri & B2B`,
            heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Solusi ${offeringTitle} Andal untuk Bisnis`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: jelaskan spesialisasi manufaktur/kontraktor, kapasitas produksi, cakupan wilayah, dan standar mutu perusahaan Anda.",
            ctaLabel: "Minta Penawaran via WhatsApp",
          },
          sales_executive: {
            eyebrow: `${SAMPLE_MARKER_LABEL} Konsultan Penjualan`,
            heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Informasi OTR & Simulasi ${city}`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: cantumkan dealer/agensi naungan, area layanan OTR, dan kemudahan test drive atau survei unit.",
            ctaLabel: "Tanya Harga OTR via WhatsApp",
          },
          personal_brand: {
            eyebrow: `${SAMPLE_MARKER_LABEL} Profil & Topik`,
            heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Pembicara, Trainer & Konsultan`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: tuliskan pernyataan posisi keahlian Anda, audiens yang biasa didampingi, dan format sesi.",
            ctaLabel: "Undang / Konsultasi via WhatsApp",
          },
          regulated_professional: {
            eyebrow: `${SAMPLE_MARKER_LABEL} Informasi Layanan`,
            heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Layanan Profesional di ${city}`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: sampaikan bidang praktik, lokasi layanan, serta jam operasional secara informasional tanpa klaim hasil pasti.",
            ctaLabel: "Buat Janji Temu via WhatsApp",
          },
          travel_umrah_agency: {
            eyebrow: hasPpiu
              ? `${SAMPLE_MARKER_LABEL} Biro Travel & Umrah`
              : `${SAMPLE_MARKER_LABEL} Biro Perjalanan Wisata`,
            heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Paket Perjalanan Terjadwal & Transparan`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: jelaskan destinasi unggulan, kejelasan maskapai dan hotel, serta layanan pendampingan peserta.",
            ctaLabel: "Tanya Jadwal Paket via WhatsApp",
          },
          offline_multibranch: {
            eyebrow: `${SAMPLE_MARKER_LABEL} Outlet & Layanan Lokal`,
            heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Menu & Lokasi Cabang ${city}`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: perkenalkan sajian atau layanan andalan, jam buka harian, serta cabang terdekat yang siap dikunjungi.",
            ctaLabel: "Reservasi via WhatsApp",
          },
          wa_catalog_showcase: {
            eyebrow: `${SAMPLE_MARKER_LABEL} Katalog Produk`,
            heading: `${SAMPLE_MARKER_LABEL} ${cleanName} — Pilihan Produk Ecer, Custom & Grosir`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: jelaskan keunggulan material produk, kesiapan pesanan custom/grosir, dan pemesanan langsung via WhatsApp.",
            ctaLabel: "Tanya Stok via WhatsApp",
          },
        };
        const heroCopy = heroCopyByBlueprint[blueprint.id];
        sections.push({
          id,
          type: "hero",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: true,
          order: order++,
          config: {
            eyebrow: heroCopy.eyebrow,
            heading: heroCopy.heading,
            subheading: heroCopy.subheading,
            primaryCta: {
              label: heroCopy.ctaLabel,
              href: waHref,
              variant: "whatsapp",
              openInNewTab: true,
            },
            secondaryCta: {
              label: `Lihat ${blueprint.sidebarOffering.primaryMenuLabel}`,
              href: blueprint.sidebarOffering.primaryRoutePath,
              variant: "secondary",
            },
            highlights: [],
          },
        });
        break;
      }

      case "highlights":
      case "features": {
        const itemsByBlueprint: Partial<
          Record<
            B2BBlueprintId,
            { heading: string; subheading: string; items: { title: string; description: string; badge: string }[] }
          >
        > = {
          b2b_corporate:
            type === "highlights"
              ? {
                  heading: `${SAMPLE_MARKER_LABEL} Fakta Kapasitas & Jangkauan Operasional`,
                  subheading:
                    "Contoh — ubah sebelum diterbitkan dengan data kapasitas, tahun berdiri, dan area layanan perusahaan.",
                  items: [
                    {
                      title: `${SAMPLE_MARKER_LABEL} Tahun Berdiri & Pengalaman`,
                      description: "Contoh — ganti dengan informasi resmi tahun berdiri usaha Anda.",
                      badge: "Fakta 1",
                    },
                    {
                      title: `${SAMPLE_MARKER_LABEL} Kapasitas & MOQ`,
                      description: "Contoh — tuliskan kapasitas produksi bulanan dan minimal order.",
                      badge: "Fakta 2",
                    },
                    {
                      title: `${SAMPLE_MARKER_LABEL} Area Pengiriman`,
                      description: "Contoh — sebutkan kota, pulau, atau area proyek yang dilayani.",
                      badge: "Fakta 3",
                    },
                  ],
                }
              : {
                  heading: `${SAMPLE_MARKER_LABEL} 5 Tahap Kerja Sama B2B`,
                  subheading:
                    "Contoh — ubah sebelum diterbitkan agar sesuai dengan alur pemesanan di perusahaan Anda.",
                  items: [
                    { title: "1. Konsultasi & Spesifikasi", description: "Diskusi kebutuhan teknis, volume, dan jadwal target.", badge: "Tahap 1" },
                    { title: "2. Sample / Survei Lokasi", description: "Pembuatan contoh produk atau survei lapangan.", badge: "Tahap 2" },
                    { title: "3. Penawaran Tertulis", description: "Pengiriman rincian harga, MOQ, dan syarat pembayaran.", badge: "Tahap 3" },
                    { title: "4. Produksi / Pelaksanaan", description: "Pengerjaan terjadwal dengan laporan progres.", badge: "Tahap 4" },
                    { title: "5. QC & Pengiriman", description: "Inspeksi mutu akhir dan serah terima dokumen.", badge: "Tahap 5" },
                  ],
                },
          sales_executive: {
            heading: `${SAMPLE_MARKER_LABEL} 4 Langkah Mudah Menuju Serah Terima`,
            subheading:
              "Contoh — ubah sebelum diterbitkan sesuai proses di dealer atau agensi naungan Anda.",
            items: [
              { title: "1. Konsultasi Unit & OTR", description: "Bandingkan varian, program berjalan, dan simulasi kredit.", badge: "Langkah 1" },
              { title: "2. Test Drive / Survei Unit", description: "Jadwalkan kunjungan di showroom atau langsung ke lokasi Anda.", badge: "Langkah 2" },
              { title: "3. Pengajuan & Berkas", description: "Pendampingan kelengkapan dokumen tunai, kredit, atau tukar tambah.", badge: "Langkah 3" },
              { title: "4. Serah Terima Unit", description: "Pengantaran unit beserta panduan fitur dan layanan purnajual.", badge: "Langkah 4" },
            ],
          },
          regulated_professional: {
            heading: `${SAMPLE_MARKER_LABEL} Alur Pendaftaran & Konsultasi`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: jelaskan tahapan layanan secara informasional dan objektif.",
            items: [
              { title: "1. Pilih Jadwal Tersedia", description: "Hubungi admin pendaftaran untuk memilih hari dan sesi.", badge: "Tahap 1" },
              { title: "2. Siapkan Dokumen Dasar", description: "Bawa kartu identitas atau dokumen pendukung yang diperlukan.", badge: "Tahap 2" },
              { title: "3. Sesi Konsultasi Langsung", description: "Diskusi langsung bersama praktisi di ruang privat.", badge: "Tahap 3" },
            ],
          },
          travel_umrah_agency: {
            heading: hasPpiu
              ? `${SAMPLE_MARKER_LABEL} Standar 5 Pasti Umrah & Permenpar 6/2025`
              : `${SAMPLE_MARKER_LABEL} Standar Transparansi Paket Permenpar 6/2025`,
            subheading:
              "Contoh — ubah sebelum diterbitkan dengan rincian izin, maskapai, dan hotel biro Anda.",
            items: [
              {
                title: hasPpiu ? "1. Pasti Berizin (PPIU)" : "1. Kelengkapan Izin Biro",
                description: hasPpiu
                  ? `Nomor izin tercatat: ${input.credentials?.skKemenagPpiu}.`
                  : "Contoh — cantumkan nomor NIB/KBLI 79121 atau SK Kemenag PPIU bila berlaku.",
                badge: "Pasti 1",
              },
              { title: "2. Pasti Jadwal & Maskapai", description: "Jadwal berangkat dan maskapai diinformasikan jelas sebelum pelunasan.", badge: "Pasti 2" },
              { title: "3. Pasti Harga & Layanan", description: "Harga per pax dan daftar termasuk/tidak termasuk disajikan terbuka.", badge: "Pasti 3" },
              { title: "4. Pasti Hotel & Akomodasi", description: "Informasi nama hotel dan jarak akses tercantum pada setiap paket.", badge: "Pasti 4" },
              { title: "5. Pasti Visa & Asuransi", description: "Pengurusan visa dan asuransi perjalanan sesuai ketentuan paket.", badge: "Pasti 5" },
            ],
          },
          wa_catalog_showcase: {
            heading: `${SAMPLE_MARKER_LABEL} Cara Pemesanan & Pengiriman`,
            subheading:
              "Contoh — ubah sebelum diterbitkan sesuai kebijakan order ecer, custom, dan grosir Anda.",
            items: [
              { title: "1. Pilih Produk di Katalog", description: "Cek foto, material, ukuran, dan status Ready/Pre-Order.", badge: "Langkah 1" },
              { title: "2. Klik Tanya via WhatsApp", description: "Konfirmasi stok, ongkir, atau permintaan spesifikasi custom.", badge: "Langkah 2" },
              { title: "3. Pembayaran Rekening Usaha", description: `Pastikan transfer hanya ke rekening atas nama ${cleanName}.`, badge: "Langkah 3" },
              { title: "4. Pengemasan & Kirim", description: "Foto bukti pengemasan dan resi dikirim langsung ke WhatsApp Anda.", badge: "Langkah 4" },
            ],
          },
        };

        const presetItems = itemsByBlueprint[blueprint.id] ?? {
          heading: `${SAMPLE_MARKER_LABEL} Keunggulan Utama`,
          subheading: "Contoh — ubah sebelum diterbitkan sesuai nilai tambah usaha Anda.",
          items: [],
        };

        sections.push({
          id,
          type,
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: true,
          order: order++,
          config: {
            eyebrow: type === "highlights" ? "Fakta Utama" : "Alur & Standar",
            heading: presetItems.heading,
            subheading: presetItems.subheading,
            columns: 3,
            items: presetItems.items,
          },
        });
        break;
      }

      case "trust_logos": {
        sections.push({
          id,
          type: "trust_logos",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: false,
          order: order++,
          config: {
            eyebrow: "Kepercayaan",
            heading:
              blueprint.id === "personal_brand"
                ? "Organisasi & Klien yang Pernah Didampingi"
                : "Sertifikasi, Kredensial & Mitra",
            subheading:
              "Tambahkan logo klien atau dokumen kredensial asli yang telah disetujui secara tertulis. Blueprint tidak pernah mengisi logo fiktif.",
            columns: 4,
            items: [],
          },
        });
        break;
      }

      case "services_grid":
      case "products_grid":
      case "tours_grid":
      case "vehicles_grid": {
        const gridOfferingType: OfferingType =
          type === "products_grid"
            ? "product"
            : type === "tours_grid"
              ? "tour"
              : type === "vehicles_grid"
                ? "vehicle"
                : "service";
        sections.push({
          id,
          type,
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: true,
          order: order++,
          config: {
            eyebrow: blueprint.sidebarOffering.primaryMenuLabel,
            heading: `Pilihan ${blueprint.sidebarOffering.primaryMenuLabel} ${cleanName}`,
            subheading: `Item ${blueprint.sidebarOffering.primaryMenuLabel.toLowerCase()} yang Anda tambahkan pada menu sidebar akan muncul otomatis di bagian ini.`,
            offeringType: gridOfferingType,
            limit: 6,
            itemSlugs: [],
            items: [],
            emptyMessage: `Belum ada ${blueprint.sidebarOffering.primaryMenuLabel.toLowerCase()} terbit. Tambahkan item pertama Anda melalui dashboard.`,
            viewAllCta: {
              label: `Lihat Semua ${blueprint.sidebarOffering.primaryMenuLabel}`,
              href: blueprint.sidebarOffering.primaryRoutePath,
              variant: "secondary",
            },
          },
        });
        break;
      }

      case "about": {
        sections.push({
          id,
          type: "about",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: true,
          order: order++,
          config: {
            eyebrow: "Fakta Terstruktur",
            heading: `${SAMPLE_DRAFT_MARKER_LABEL} ${blueprint.factSheetHeading}`,
            subheading:
              "Contoh — ganti dengan informasi asli agar pengunjung, mesin pencari, dan asisten AI dapat membaca fakta usaha secara akurat.",
            bodyHtml: factSheetHtml,
            milestones: [],
          },
        });
        break;
      }

      case "gallery": {
        const galleryHeading =
          blueprint.id === "sales_executive"
            ? "Galeri Serah Terima Unit"
            : blueprint.id === "personal_brand"
              ? "Publikasi, Buku & Dokumentasi Sesi"
              : blueprint.id === "travel_umrah_agency"
                ? "Dokumentasi Rombongan & Perjalanan"
                : "Galeri Dokumentasi Asli";
        sections.push({
          id,
          type: "gallery",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: false,
          order: order++,
          config: {
            eyebrow: "Dokumentasi",
            heading: galleryHeading,
            subheading:
              "Unggah foto asli atau tautan video YouTube melalui menu Media sebelum mengaktifkan bagian ini.",
            columns: 3,
            items: [],
          },
        });
        break;
      }

      case "testimonials": {
        sections.push({
          id,
          type: "testimonials",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          // Omit `enabled` on regulated medical so validatePageSections emits Permenkes warning + defaultedOff;
          // on legal/tax regulated or non-regulated keep explicitly disabled (`enabled: false`)!
          ...(blueprint.testimonialsDefaultOff &&
          (input.regulatedSubtype ?? "medical_clinic") === "medical_clinic"
            ? {}
            : { enabled: false }),
          order: order++,
          config: {
            eyebrow: "Ulasan",
            heading: "Ulasan Klien Asli",
            subheading: blueprint.testimonialsDefaultOff
              ? (ethicsNoticeOverride ??
                "Dinonaktifkan secara default sesuai ketentuan Permenkes dan kode etik profesi.")
              : "Tambahkan ulasan asli dari klien Anda. Blueprint tidak pernah membuat testimoni fiktif.",
            items: [],
          },
        });
        break;
      }

      case "blog_latest": {
        sections.push({
          id,
          type: "blog_latest",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: false,
          order: order++,
          config: {
            eyebrow: "Edukasi & Artikel",
            heading: "Artikel Terbaru",
            subheading:
              "Tiga kerangka artikel draf sudah disiapkan di menu Artikel. Sunting dan terbitkan untuk menampilkan di sini.",
            limit: 3,
            posts: [],
            viewAllHref: "/blog",
            viewAllLabel: "Lihat Semua Artikel",
          },
        });
        break;
      }

      case "faq": {
        sections.push({
          id,
          type: "faq",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: false,
          order: order++,
          config: {
            eyebrow: "FAQ",
            heading: `${SAMPLE_MARKER_LABEL} Pertanyaan yang Sering Diajukan`,
            subheading:
              "Contoh — ubah sebelum diterbitkan agar sesuai dengan prosedur layanan usaha Anda.",
            items: [
              {
                question: `${SAMPLE_MARKER_LABEL} Bagaimana cara menghubungi tim ${cleanName}?`,
                answer:
                  "Contoh — ubah sebelum diterbitkan: jelaskan jam respons WhatsApp, alur konsultasi awal, dan dokumen atau informasi yang perlu disiapkan.",
                defaultOpen: false,
              },
            ],
          },
        });
        break;
      }

      case "custom_form": {
        sections.push({
          id,
          type: "custom_form",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: true,
          order: order++,
          config: {
            eyebrow: "Formulir Cepat",
            heading: formTemplate?.defaultName ?? `Formulir Pertanyaan ${cleanName}`,
            subheading:
              formTemplate?.defaultDescription ??
              "Isi formulir singkat berikut dan tim kami akan segera menghubungi Anda.",
            primaryCta: {
              label: formTemplate?.submitLabel ?? "Kirim Permintaan",
              href: `#formulir-${formSlug}`,
              variant: "primary",
            },
            secondaryCta: {
              label: "Hubungi via WhatsApp",
              href: waHref,
              variant: "whatsapp",
              openInNewTab: true,
            },
            note: blueprint.requiresSensitiveDataNotice
              ? "Perhatian UU PDP: formulir ini khusus penjadwalan. Jangan menuliskan riwayat penyakit detail atau rahasia perkara hukum."
              : "Data formulir hanya digunakan untuk menindaklanjuti permintaan Anda.",
            formSlug,
          },
        });
        break;
      }

      case "branches": {
        sections.push({
          id,
          type: "branches",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: true,
          order: order++,
          config: {
            eyebrow: "Lokasi & Cabang",
            heading: `Cabang & Jam Operasional ${cleanName}`,
            subheading:
              "Contoh — ubah sebelum diterbitkan: lengkapi alamat tiap cabang, jam hari kerja/libur, dan tautan Google Maps.",
            address: input.address || `${SAMPLE_MARKER_LABEL} Alamat cabang utama (${city})`,
            ...(input.weekdayHours ? { weekdayHours: input.weekdayHours } : {}),
            ...(input.holidayHours ? { holidayHours: input.holidayHours } : {}),
            whatsappPhone: input.whatsappPhone,
            whatsappLabel: "WhatsApp Cabang Utama",
            mapsLabel: "Buka di Google Maps",
            branches: [],
          },
        });
        break;
      }

      case "contact_location": {
        sections.push({
          id,
          type: "contact_location",
          schemaVersion: SECTION_REGISTRY_SCHEMA_VERSION,
          enabled: true,
          order: order++,
          config: {
            eyebrow: "Kontak",
            heading: `Hubungi ${cleanName}`,
            subheading:
              "Hubungi langsung melalui WhatsApp atau kunjungi lokasi pada jam operasional.",
            address: input.address || `${SAMPLE_MARKER_LABEL} Lengkapi alamat usaha di Pengaturan (${city})`,
            ...(input.weekdayHours ? { weekdayHours: input.weekdayHours } : {}),
            ...(input.holidayHours ? { holidayHours: input.holidayHours } : {}),
            whatsappPhone: input.whatsappPhone,
            whatsappLabel: "Chat via WhatsApp",
            mapsLabel: "Buka di Google Maps",
            branches: [],
          },
        });
        break;
      }
    }
  }

  return sections;
}

export interface AppliedVerticalBlueprint {
  readonly blueprint: BlueprintDefinition;
  readonly input: ValidatedMinimalOnboardingInput;
  readonly resolvedBusinessCategory: ClosedBusinessCategoryKey;
  readonly resolvedSchemaPrimaryType: string;
  readonly regulatedEthicsNotice: string | null;
  readonly recommendedThemeId: PlatformThemeId;
  readonly recommendedStyleVariant: string;
  readonly sidebarOffering: BlueprintSidebarOfferingConfig;
  readonly sections: readonly AnyValidatedPageSection[];
  readonly sampleSectionIds: readonly string[];
  readonly warnings: readonly SectionValidationWarning[];
  readonly isHealthCategory: boolean;
  readonly aiFactSheetHtml: string;
  readonly aiFactSheetDefinitionListHtml: string;
  readonly aiFactSheetItems: readonly BlueprintFactSheetItem[];
  readonly activeTourDepartures: readonly BlueprintTourDepartureRow[];
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly profilePageSchema: ProfilePageSchemaGraph | null;
  readonly aggregateRatingDisabled: boolean;
  readonly draftBlogOutlines: readonly BlueprintDraftBlogOutline[];
  readonly whatsappMessagePreview: string;
  readonly whatsappUrl: string;
  readonly starterFormId: BlueprintStarterFormId;
  readonly starterFormTemplate: FormVerticalTemplate;
  readonly credentialPrompts: readonly CredentialFieldDefinition[];
  readonly localListingsCard: BlueprintLocalListingsCard;
  readonly autoEnableFreePlugins: readonly string[];
}

/**
 * Applies one of the 7 Zero-Guesswork B2B Vertical Conversion Blueprints from
 * minimal 3-field onboarding input (`businessName`, `blueprintId`, `whatsappPhone`).
 * Server clock (`options.now`) is passed separately and never accepted from client payloads.
 */
export function applyVerticalBlueprint(
  rawInput: MinimalOnboardingInput,
  options: ApplyVerticalBlueprintOptions = {},
): AppliedVerticalBlueprint {
  const input = MinimalOnboardingInputSchema.parse(rawInput);
  const blueprint = B2B_VERTICAL_BLUEPRINTS[input.blueprintId];
  const now = options.now ?? new Date();

  const regulatedMeta =
    blueprint.id === "regulated_professional"
      ? REGULATED_SUBTYPE_META[input.regulatedSubtype ?? "medical_clinic"]
      : null;

  const resolvedBusinessCategory: ClosedBusinessCategoryKey =
    regulatedMeta?.businessCategory ?? blueprint.defaultBusinessCategory;
  const resolvedSchemaPrimaryType =
    regulatedMeta?.schemaPrimaryType ?? blueprint.schemaPrimaryType;

  const city = input.city || "Indonesia";
  const offeringTitle = input.primaryOfferingTitle || blueprint.sidebarOffering.primaryMenuLabel;
  const dealer = input.affiliatedDealerName?.trim() || "";
  const shortName = input.businessName.split(/\s+/)[0] || input.businessName;
  const canonicalOrigin =
    input.canonicalOrigin ?? `https://${input.handle ?? "situs-anda"}.situsku.click`;

  const certLabel =
    input.credentials?.isoSniTkdn?.trim() ||
    (input.credentials?.nib?.trim() ? `NIB ${input.credentials.nib.trim()}` : "");

  const templateVars: Record<string, string> = {
    nama_bisnis: input.businessName,
    nama_panggilan: shortName,
    judul_halaman: offeringTitle,
    layanan_utama: offeringTitle,
    kota: city,
    dealer_suffix: dealer ? ` (${dealer})` : "",
    sertifikasi_suffix: certLabel ? ` | ${certLabel}` : "",
  };

  const whatsappMessagePreview = formatTemplate(blueprint.whatsappMessageTemplate, templateVars);
  const whatsappUrl = `https://wa.me/${input.whatsappPhone}?text=${encodeURIComponent(whatsappMessagePreview)}`;

  const metaTitle = formatTemplate(blueprint.metaTitleTemplate, templateVars);
  const metaDescription = formatTemplate(blueprint.metaDescriptionTemplate, templateVars);

  const factSheet = buildFactSheetHtml(blueprint, input, now);
  const rawSections = buildBlueprintRawSections(
    blueprint,
    input,
    factSheet.html,
    whatsappUrl,
    regulatedMeta?.ethicsNotice ?? null,
  );

  const validated = validatePageSections(rawSections, {
    businessCategory: resolvedBusinessCategory,
  });

  const sampleSectionIds = computeSampleSectionIds(validated.sections);
  const firstDraftOutline = blueprint.draftBlogOutlines[0];

  const profilePageSchema = buildBlueprintProfilePageSchema({
    blueprintId: blueprint.id,
    personName: input.businessName,
    canonicalOrigin,
    affiliatedOrganizationName:
      blueprint.id === "sales_executive" && dealer ? dealer : undefined,
    areaServed: city,
    sampleBlogPostSlug: firstDraftOutline?.slug,
    sampleBlogPostHeadline: firstDraftOutline?.title,
  });

  const starterFormTemplate = getFormVerticalTemplate(blueprint.formTemplateKey);
  if (!starterFormTemplate) {
    throw new Error(`Missing starter form template "${blueprint.formTemplateKey}"`);
  }

  const credentialPrompts = getPromptedCredentialsForCategory(resolvedBusinessCategory);

  // Never fabricate street address or operating hours when not supplied!
  const localListingsCard = buildDualLocalListingsCopyCard({
    businessName: input.businessName,
    categoryLabel: blueprint.name,
    address: input.address ?? null,
    weekdayHours: input.weekdayHours ?? null,
    holidayHours: input.holidayHours ?? null,
    whatsappE164: `+${input.whatsappPhone}`,
    websiteUrl: `${canonicalOrigin}/`,
  });

  const activeTourDepartures =
    blueprint.id === "travel_umrah_agency"
      ? filterActiveTourDepartures(input.tourDepartures ?? [], now)
      : [];

  return {
    blueprint,
    input,
    resolvedBusinessCategory,
    resolvedSchemaPrimaryType,
    regulatedEthicsNotice: regulatedMeta?.ethicsNotice ?? null,
    recommendedThemeId: blueprint.defaultThemeId,
    recommendedStyleVariant: blueprint.defaultStyleVariant,
    sidebarOffering: blueprint.sidebarOffering,
    sections: validated.sections,
    sampleSectionIds,
    warnings: validated.warnings,
    isHealthCategory: validated.isHealthCategory,
    aiFactSheetHtml: factSheet.html,
    aiFactSheetDefinitionListHtml: factSheet.dlHtml,
    aiFactSheetItems: factSheet.items,
    activeTourDepartures,
    metaTitle,
    metaDescription,
    profilePageSchema,
    aggregateRatingDisabled: blueprint.aggregateRatingDisabled,
    draftBlogOutlines: blueprint.draftBlogOutlines,
    whatsappMessagePreview,
    whatsappUrl,
    starterFormId: blueprint.starterFormId,
    starterFormTemplate,
    credentialPrompts,
    localListingsCard,
    autoEnableFreePlugins: blueprint.autoEnableFreePlugins,
  };
}

/**
 * Non-destructively merges a newly previewed/applied blueprint onto existing
 * user-entered sections so switching blueprints NEVER deletes user content,
 * AND disables every sample `[Contoh]` section in the resulting page draft so
 * unedited starter text can never be published accidentally (REQ-093).
 */
export function mergeBlueprintNonDestructively(
  existingUserSections: readonly AnyValidatedPageSection[],
  nextBlueprint: AppliedVerticalBlueprint,
): readonly AnyValidatedPageSection[] {
  const merged = mergeStarterPresetDraftSections(
    existingUserSections,
    nextBlueprint.sections,
    nextBlueprint.resolvedBusinessCategory,
  );
  return disableSampleSectionsForPageDraft(merged);
}

/**
 * Helper resolving the adaptive sidebar offering label & hidden types from a blueprint ID.
 */
export function getAdaptiveSidebarOfferingForBlueprint(
  blueprintId: B2BBlueprintId,
): BlueprintSidebarOfferingConfig {
  return B2B_VERTICAL_BLUEPRINTS[blueprintId].sidebarOffering;
}

export type { IndonesianBusinessCredentials };
