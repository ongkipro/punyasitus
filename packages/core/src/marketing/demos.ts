import {
  DEMO_READ_ONLY_ERROR_CODE,
  DEMO_THEME_SLUGS,
  formatIdr,
  type DemoThemeSlug,
} from "./constants.ts";

/**
 * Six 100% synthetic Indonesian demo businesses covering all 6 platform themes
 * (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`) for `punyasitus.com/marketing/demo/*`
 * (REQ-087, PLAN §19.5, DESIGN.md §7, TASK-087).
 *
 * Synthetic-data guardrails:
 * - ZERO real customer records, real phone numbers, or real business registrations.
 * - All synthetic WhatsApp numbers strictly use `6281200000001`..`6281200000006`.
 * - All synthetic emails strictly use `@contoh.punyasitus.test`.
 * - Every demo site is read-only (`403 DEMO_READ_ONLY` on mutations) and `noindex, nofollow`.
 */

export interface DemoOfferingItem {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly priceLabel: string;
  readonly priceIdr?: number;
  readonly badge?: string;
  readonly status?: "available" | "booked" | "sold";
  readonly summary: string;
  readonly specs: readonly { readonly label: string; readonly value: string }[];
}

export interface DemoBranchLocation {
  readonly name: string;
  readonly city: string;
  readonly address: string;
  readonly hoursWeekday: string;
  readonly hoursWeekend: string;
  readonly syntheticPhone: string;
  readonly mapsQuery: string;
}

export interface DemoCreditRow {
  readonly dpPercent: number;
  readonly dpAmountIdr: number;
  readonly principalIdr: number;
  readonly installmentsByTenor: readonly {
    readonly tenorMonths: number;
    readonly monthlyInstallmentIdr: number;
  }[];
}

export interface DemoCreditSimulation {
  readonly vehicleTitle: string;
  readonly otrPriceIdr: number;
  readonly flatYearlyRateBps: number;
  readonly tenorsMonths: readonly number[];
  readonly rows: readonly DemoCreditRow[];
  readonly disclaimer: string;
}

export interface DemoTenantFixture {
  readonly slug: DemoThemeSlug;
  readonly themeName: string;
  readonly verticalLabel: string;
  readonly businessName: string;
  readonly tagline: string;
  readonly description: string;
  readonly heroCtaLabel: string;
  readonly accentColor: string;
  readonly accentSecondary: string;
  readonly surfaceTint: string;
  readonly syntheticWhatsapp: string;
  readonly syntheticEmail: string;
  readonly syntheticAddress: string;
  readonly city: string;
  readonly credentials: readonly { readonly label: string; readonly value: string }[];
  readonly highlights: readonly { readonly label: string; readonly value: string }[];
  readonly processSteps?: readonly { readonly step: string; readonly title: string; readonly detail: string }[];
  readonly items: readonly DemoOfferingItem[];
  readonly itinerary?: readonly { readonly day: string; readonly title: string; readonly detail: string }[];
  readonly branches?: readonly DemoBranchLocation[];
  readonly creditSimulation?: DemoCreditSimulation;
  readonly faq: readonly { readonly question: string; readonly answer: string }[];
}

function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/**
 * Pure server-side integer Rupiah static credit estimation matching PLAN §19.1 (`REQ-079`).
 * Zero floating-point drift, zero client JavaScript.
 */
export function computeStaticCreditSimulation(input: {
  readonly vehicleTitle: string;
  readonly otrPriceIdr: number;
  readonly dpPercents: readonly number[];
  readonly tenorsMonths: readonly number[];
  readonly flatYearlyRateBps: number;
}): DemoCreditSimulation {
  const rows: DemoCreditRow[] = input.dpPercents.map((dpPercent) => {
    const dpAmountIdr = roundHalfUp(input.otrPriceIdr * dpPercent, 100);
    const principalIdr = Math.max(0, input.otrPriceIdr - dpAmountIdr);
    const installmentsByTenor = input.tenorsMonths.map((tenorMonths) => {
      const yearsNum = tenorMonths; // years = tenorMonths / 12
      // totalWithInterest = principal * (120000 + flatYearlyRateBps * tenorMonths) / 120000
      const totalWithInterest = roundHalfUp(
        principalIdr * (120_000 + input.flatYearlyRateBps * yearsNum),
        120_000,
      );
      const monthlyInstallmentIdr = roundHalfUp(totalWithInterest, tenorMonths);
      return { tenorMonths, monthlyInstallmentIdr };
    });
    return {
      dpPercent,
      dpAmountIdr,
      principalIdr,
      installmentsByTenor,
    };
  });

  return {
    vehicleTitle: input.vehicleTitle,
    otrPriceIdr: input.otrPriceIdr,
    flatYearlyRateBps: input.flatYearlyRateBps,
    tenorsMonths: input.tenorsMonths,
    rows,
    disclaimer:
      "Simulasi estimasi cicilan bersifat ilustratif (suku bunga flat contoh " +
      `${(input.flatYearlyRateBps / 100).toFixed(1)}%/tahun, belum termasuk asuransi & biaya administrasi). ` +
      "Bukan penawaran pembiayaan resmi; perhitungan final mengikuti lembaga pembiayaan terkait.",
  };
}

const DEALER_CREDIT_SIMULATION = computeStaticCreditSimulation({
  vehicleTitle: "Toyota Avanza 1.5 G CVT (2024)",
  otrPriceIdr: 268_000_000,
  dpPercents: [20, 30, 40],
  tenorsMonths: [12, 24, 36, 48],
  flatYearlyRateBps: 550, // 5.5% flat/tahun contoh
});

export const DEMO_TENANT_FIXTURES: readonly DemoTenantFixture[] = [
  {
    slug: "compro",
    themeName: "Tema Compro",
    verticalLabel: "Kontraktor & Renovasi B2B",
    businessName: "PT Karya Bangun Nusantara",
    tagline: "Konstruksi Komersial, Gudang Industri & Renovasi Kantor Terukur",
    description:
      "Contoh tampilan situs profil perusahaan B2B untuk kontraktor sipil dan interior komersial dengan daftar kapabilitas, proyek referensi, standar mutu, dan ajakan survei lokasi.",
    heroCtaLabel: "Minta Penawaran Proyek (Demo)",
    accentColor: "#176b51",
    accentSecondary: "#0f4c5c",
    surfaceTint: "#f2f7f5",
    syntheticWhatsapp: "6281200000001",
    syntheticEmail: "demo-compro@contoh.punyasitus.test",
    syntheticAddress: "Jl. Industri Raya Contoh No. 18, Cikarang, Bekasi (Alamat Simulasi)",
    city: "Bekasi",
    credentials: [
      { label: "NIB (Contoh)", value: "CONTOH-0123456789012" },
      { label: "SBUJK (Contoh)", value: "BG004 — Bangunan Komersial" },
      { label: "Cakupan Layanan", value: "Jabodetabek & Jawa Barat" },
    ],
    highlights: [
      { label: "Fokus Sektor", value: "Kantor, Gudang & Ritel" },
      { label: "Skema Kerja", value: "RAB Transparan + Termin" },
      { label: "Masa Pemeliharaan", value: "Retensi 90 Hari (Contoh)" },
    ],
    processSteps: [
      { step: "01", title: "Survei & Brief Teknis", detail: "Pengukuran lapangan dan pemetaan kebutuhan ruang atau struktur." },
      { step: "02", title: "Penyusunan RAB & Jadwal", detail: "Rincian spesifikasi material dan kurva-S pengerjaan." },
      { step: "03", title: "Eksekusi & Pengawasan K3", detail: "Laporan progres mingguan beserta dokumentasi foto." },
      { step: "04", title: "Serah Terima & Retensi", detail: "Checklist kualitas bersama sebelum berita acara serah terima." },
    ],
    items: [
      {
        id: "compro-1",
        title: "Pembangunan Gudang Logistik & Baja Ringan",
        category: "Konstruksi Industri",
        priceLabel: "Berdasarkan RAB",
        badge: "B2B",
        summary: "Perencanaan struktur baja WF, lantai epoxy heavy-duty, serta sistem drainase kawasan industri.",
        specs: [
          { label: "Luas Minimum", value: "500 m² (Contoh)" },
          { label: "Estimasi Durasi", value: "16–24 Minggu" },
        ],
      },
      {
        id: "compro-2",
        title: "Fit-Out & Renovasi Kantor Korporat",
        category: "Interior Komersial",
        priceLabel: `Mulai ${formatIdr(3_850_000)} / m²`,
        badge: "Populer",
        summary: "Partisi akustik ruang rapat, kelistrikan MEP, plafon modular, dan furnitur built-in sesuai standar gedung.",
        specs: [
          { label: "Standar Kerja", value: "Jam Kerja Gedung / Malam" },
          { label: "Garansi MEP", value: "90 Hari (Contoh)" },
        ],
      },
      {
        id: "compro-3",
        title: "Pemeliharaan Berkala Gedung & Ruko",
        category: "Maintenance",
        priceLabel: "Kontrak Tahunan",
        summary: "Perbaikan waterproofing, pengecatan fasad, panel listrik, dan pemeliharaan utilitas operasional.",
        specs: [
          { label: "Jadwal Inspeksi", value: "Bulanan / Triwulanan" },
          { label: "SLA Respon", value: "24 Jam Kerja (Contoh)" },
        ],
      },
    ],
    branches: [
      {
        name: "Kantor Pusat & Workshop Bekasi (Contoh)",
        city: "Bekasi",
        address: "Jl. Industri Raya Contoh No. 18, Cikarang, Bekasi",
        hoursWeekday: "Senin–Jumat, 08.00–17.00 WIB",
        hoursWeekend: "Sabtu, 08.00–13.00 WIB (Minggu Tutup)",
        syntheticPhone: "6281200000001",
        mapsQuery: "Cikarang+Bekasi",
      },
      {
        name: "Perwakilan Proyek Bandung (Contoh)",
        city: "Bandung",
        address: "Jl. Soekarno-Hatta Contoh No. 204, Bandung",
        hoursWeekday: "Senin–Jumat, 08.30–17.00 WIB",
        hoursWeekend: "Sabtu–Minggu Tutup",
        syntheticPhone: "6281200000001",
        mapsQuery: "Bandung+Jawa+Barat",
      },
    ],
    faq: [
      {
        question: "Apakah survei lokasi dikenakan biaya?",
        answer: "Pada contoh alur B2B ini, survei awal untuk wilayah Jabodetabek dijadwalkan setelah brief teknis dan estimasi luas diterima.",
      },
      {
        question: "Apakah data proyek ini nyata?",
        answer: "Tidak. Seluruh nama perusahaan, nomor izin, harga, dan alamat pada halaman ini adalah data simulasi demo PunyaSitus.",
      },
    ],
  },
  {
    slug: "sales",
    themeName: "Tema Sales",
    verticalLabel: "Konsultan Bisnis & Pembicara",
    businessName: "Dr. Hendra Wijaya",
    tagline: "Konsultan Strategi Pertumbuhan UMKM & Pembicara Korporat",
    description:
      "Contoh tampilan situs personal branding & jasa profesional untuk konsultan, pembicara, atau sales executive dengan struktur kredensial, topik layanan, alur kerja, dan ajakan konsultasi.",
    heroCtaLabel: "Jadwalkan Konsultasi (Demo)",
    accentColor: "#1e40af",
    accentSecondary: "#0f766e",
    surfaceTint: "#f4f6fb",
    syntheticWhatsapp: "6281200000002",
    syntheticEmail: "demo-sales@contoh.punyasitus.test",
    syntheticAddress: "Jl. Jend. Sudirman Contoh Kav. 42, Jakarta Selatan (Alamat Simulasi)",
    city: "Jakarta Selatan",
    credentials: [
      { label: "Bidang Fokus", value: "Operasional & Skala Penjualan B2B" },
      { label: "Sertifikasi (Contoh)", value: "CONTOH-CMC / Certified Trainer" },
      { label: "Format Sesi", value: "Tatap Muka & Daring Nasional" },
    ],
    highlights: [
      { label: "Klien Sasaran", value: "Direksi, Tim Sales & Pendiri Usaha" },
      { label: "Output Utama", value: "Playbook SOP & KPI 90 Hari" },
      { label: "Bahasa Sesi", value: "Bahasa Indonesia & Inggris" },
    ],
    processSteps: [
      { step: "01", title: "Sesi Diagnostik 30 Menit", detail: "Memetakan hambatan konversi, margin, dan struktur tim penjualan." },
      { step: "02", title: "Proposal Ruang Lingkup", detail: "Menentukan format in-house training atau pendampingan kuartalan." },
      { step: "03", title: "Pelaksanaan & Evaluasi", detail: "Workshop praktis berbasis studi kasus internal + tinjauan 30 hari." },
    ],
    items: [
      {
        id: "sales-1",
        title: "In-House Workshop: Sistem Penjualan B2B Terukur",
        category: "Pelatihan Korporat",
        priceLabel: `Mulai ${formatIdr(12_500_000)} / sesi`,
        badge: "1 Hari Penuh",
        summary: "Menyusun alur kualifikasi prospek, skrip negosiasi, dan laporan pipeline harian untuk tim sales 10–40 orang.",
        specs: [
          { label: "Durasi", value: "6 Jam + Modul Kerja" },
          { label: "Peserta", value: "Hingga 40 Orang" },
        ],
      },
      {
        id: "sales-2",
        title: "Pendampingan Eksekutif & Audit Funnel (90 Hari)",
        category: "Konsultasi Bisnis",
        priceLabel: "Harga Berdasarkan Penawaran",
        summary: "Review dua mingguan bersama pendiri dan kepala penjualan untuk membenahi harga, retensi, dan target cabang.",
        specs: [
          { label: "Pertemuan", value: "6 Sesi + Audit Data" },
          { label: "Deliverable", value: "Dokumen SOP & Dashboard KPI" },
        ],
      },
      {
        id: "sales-3",
        title: "Keynote Speaker — Rapat Kerja & Konferensi",
        category: "Pembicara",
        priceLabel: `Mulai ${formatIdr(8_500_000)}`,
        summary: "Materi inspiratif namun membumi tentang transformasi pemasaran digital dan disiplin eksekusi tim.",
        specs: [
          { label: "Durasi", value: "60–90 Menit + Tanya Jawab" },
          { label: "Penyesuaian", value: "Disesuaikan Industri Klien" },
        ],
      },
    ],
    faq: [
      {
        question: "Apakah jadwal dan tarif pada halaman ini berlaku sungguhan?",
        answer: "Tidak. Profil Dr. Hendra Wijaya merupakan tokoh fiktif untuk mendemonstrasikan struktur tema Sales di PunyaSitus.",
      },
      {
        question: "Apakah tema ini cocok untuk agen properti atau konsultan pajak?",
        answer: "Ya. Struktur kredensial, daftar layanan, dan tombol konsultasi WhatsApp dirancang untuk profesi jasa dan sales konsultan.",
      },
    ],
  },
  {
    slug: "travel",
    themeName: "Tema Travel",
    verticalLabel: "Biro Perjalanan & Umrah",
    businessName: "Berkah Safar Wisata",
    tagline: "Paket Perjalanan Terstruktur, Transparan & Pendampingan Penuh",
    description:
      "Contoh tampilan situs biro perjalanan dan Umrah sesuai prinsip transparansi informasi (maskapai, hotel, termasuk/tidak termasuk, itinerary harian) tanpa klaim kuota palsu.",
    heroCtaLabel: "Konsultasi Jadwal Paket (Demo)",
    accentColor: "#0f5c5c",
    accentSecondary: "#92400e",
    surfaceTint: "#f2f7f6",
    syntheticWhatsapp: "6281200000003",
    syntheticEmail: "demo-travel@contoh.punyasitus.test",
    syntheticAddress: "Jl. Margonda Contoh No. 88, Depok, Jawa Barat (Alamat Simulasi)",
    city: "Depok",
    credentials: [
      { label: "Izin PPIU (Contoh)", value: "CONTOH-SK-KEMENAG-000/2026" },
      { label: "Keanggotaan (Contoh)", value: "Asosiasi Biro Perjalanan (Simulasi)" },
      { label: "Prinsip Layanan", value: "5 Pasti — Informasi Terbuka" },
    ],
    highlights: [
      { label: "Jenis Paket", value: "Umrah Reguler, Wisata Halal & Grup" },
      { label: "Transparansi", value: "Maskapai & Hotel Dicantumkan Jelas" },
      { label: "Pendaftaran", value: "Konsultasi & Verifikasi Langsung" },
    ],
    items: [
      {
        id: "travel-1",
        title: "Umrah Reguler 9 Hari — Program Ekonomi Nyaman",
        category: "Umrah",
        priceLabel: formatIdr(29_900_000),
        priceIdr: 29_900_000,
        badge: "9 Hari 7 Malam",
        summary: "Penerbangan langsung Jakarta–Jeddah (contoh), hotel Makkah & Madinah jarak jalan kaki, pembimbing ibadah berbahasa Indonesia.",
        specs: [
          { label: "Hotel Madinah", value: "Setaraf Bintang 4 (Contoh)" },
          { label: "Hotel Makkah", value: "Setaraf Bintang 4 (Contoh)" },
          { label: "Termasuk", value: "Tiket PP, Visa, Hotel, Makan 3x, Asuransi" },
          { label: "Belum Termasuk", value: "Paspor, Vaksin, Pengeluaran Pribadi" },
        ],
      },
      {
        id: "travel-2",
        title: "Wisata Halal Turki 10 Hari — Istanbul & Cappadocia",
        category: "Wisata Halal",
        priceLabel: `Mulai ${formatIdr(22_400_000)}`,
        badge: "10 Hari",
        summary: "Kunjungan masjid bersejarah, jadwal salat terjaga, restoran bersertifikat halal, dan pemandu resmi lokal.",
        specs: [
          { label: "Akomodasi", value: "Hotel Bintang 4 Twin Share" },
          { label: "Transportasi", value: "Bus Wisata AC & Wi-Fi" },
        ],
      },
      {
        id: "travel-3",
        title: "Gathering Korporat & Edukasi Bali 3 Hari 2 Malam",
        category: "Grup Perusahaan",
        priceLabel: `Mulai ${formatIdr(3_650_000)} / peserta`,
        badge: "Min. 20 Peserta",
        summary: "Paket fleksibel untuk rapat kerja perusahaan lengkap dengan ruang pertemuan, makan malam tim, dan transportasi bandara.",
        specs: [
          { label: "Durasi", value: "3 Hari 2 Malam" },
          { label: "Kustomisasi", value: "Agenda & Hotel Menyesuaikan Anggaran" },
        ],
      },
    ],
    itinerary: [
      { day: "Hari 1", title: "Keberangkatan Jakarta – Madinah", detail: "Kumpul di Bandara Soekarno-Hatta, pengarahan rombongan, penerbangan menuju Madinah, dan check-in hotel." },
      { day: "Hari 2–4", title: "Ibadah & Ziarah Kota Madinah", detail: "Shalat berjamaah di Masjid Nabawi, ziarah Raudhah (sesuai jadwal resmi), dan kunjungan Masjid Quba." },
      { day: "Hari 5–8", title: "Perjalanan ke Makkah & Pelaksanaan Umrah", detail: "Miqat di Bir Ali, pelaksanaan Tawaf, Sa'i, dan Tahallul bersama pembimbing, dilanjutkan ibadah mandiri." },
      { day: "Hari 9", title: "Kepulangan Jeddah – Jakarta", detail: "Tawaf Wada, transfer ke bandara Jeddah, dan kepulangan ke tanah air." },
    ],
    faq: [
      {
        question: "Apakah situs ini menjual tiket secara instan (OTA)?",
        answer: "Tidak. Tema Travel PunyaSitus dirancang sebagai katalog paket perjalanan resmi yang mengarahkan calon peserta ke konsultasi langsung dan verifikasi dokumen.",
      },
      {
        question: "Mengapa tidak ada penghitung sisa kursi otomatis?",
        answer: "PunyaSitus menghindari klaim kelangkaan palsu. Ketersediaan rombongan dikonfirmasi langsung oleh admin biro perjalanan.",
      },
    ],
  },
  {
    slug: "catalog",
    themeName: "Tema Catalog",
    verticalLabel: "Katalog Furnitur & Produk -> WhatsApp",
    businessName: "Kayu Jati Jepara Craft",
    tagline: "Furnitur Kayu Jati Solid Langsung dari Pengrajin untuk Rumah & Kafe",
    description:
      "Contoh tampilan katalog produk dengan variasi model harga (tetap, rentang grosir, mulai dari), label Nego/Pre-Order, spesifikasi ukuran, dan pemesanan langsung ke WhatsApp.",
    heroCtaLabel: "Tanya Stok & Katalog WA (Demo)",
    accentColor: "#1d4ed8",
    accentSecondary: "#0f766e",
    surfaceTint: "#f4f6fa",
    syntheticWhatsapp: "6281200000004",
    syntheticEmail: "demo-catalog@contoh.punyasitus.test",
    syntheticAddress: "Jl. Pengrajin Jati Contoh No. 11, Tahunan, Jepara (Alamat Simulasi)",
    city: "Jepara",
    credentials: [
      { label: "Bahan Baku", value: "Kayu Jati Perhutani Kering Oven (Contoh)" },
      { label: "Pesanan Khusus", value: "Terima Ukuran Custom & Proyek Kafe" },
      { label: "Pengiriman", value: "Ekspedisi Truk Mebel Jawa–Bali–Sumatera" },
    ],
    highlights: [
      { label: "Skema Harga", value: "Eceran, Grosir & Custom" },
      { label: "Finishing", value: "Natural Doff / Salak Brown / Walnut" },
      { label: "Alur Pesan", value: "Pilih Produk -> Konfirmasi WhatsApp" },
    ],
    items: [
      {
        id: "catalog-1",
        title: "Meja Makan Trembesi Solid 200 cm (6 Kursi)",
        category: "Ruang Makan",
        priceLabel: formatIdr(7_850_000),
        priceIdr: 7_850_000,
        badge: "Siap Kirim • Nego",
        summary: "Daun meja kayu utuh tebal 6 cm dengan kaki besi hollow powder-coating anti karat.",
        specs: [
          { label: "Dimensi", value: "200 × 90 × 76 cm" },
          { label: "Finishing", value: "Melamine Natural Doff" },
        ],
      },
      {
        id: "catalog-2",
        title: "Kursi Kafe Jati Rangka Minimalis (Paket Grosir)",
        category: "Furnitur Kafe",
        priceLabel: `${formatIdr(690_000)} – ${formatIdr(820_000)} / unit`,
        badge: "Grosir Min. 12 Unit",
        summary: "Konstruksi pasak kuat untuk pemakaian intensif restoran dan kedai kopi dengan opsi bantalan oscar.",
        specs: [
          { label: "Tinggi Dudukan", value: "45 cm" },
          { label: "Estimasi PO", value: "14 Hari Kerja" },
        ],
      },
      {
        id: "catalog-3",
        title: "Lemari Pakaian Jati 3 Pintu Geser",
        category: "Kamar Tidur",
        priceLabel: formatIdr(6_400_000),
        priceIdr: 6_400_000,
        badge: "Pre-Order",
        summary: "Rel geser baja senyap, ruang gantung gamis/jas, serta 2 laci penyimpanan berkunci.",
        specs: [
          { label: "Dimensi", value: "160 × 58 × 210 cm" },
          { label: "Bahan", value: "Jati Grade A (Contoh)" },
        ],
      },
      {
        id: "catalog-4",
        title: "Meja Kerja Eksekutif L-Shape + Laci",
        category: "Ruang Kerja",
        priceLabel: `Mulai ${formatIdr(4_250_000)}`,
        badge: "Bisa Custom Ukuran",
        summary: "Lubang manajemen kabel rapi, laci dokumen 3 susun, cocok untuk kantor dan ruang kerja rumah.",
        specs: [
          { label: "Dimensi", value: "150 × 140 × 75 cm" },
          { label: "Garansi Struktur", value: "1 Tahun (Contoh)" },
        ],
      },
    ],
    faq: [
      {
        question: "Apakah katalog ini menggunakan keranjang belanja otomatis?",
        answer: "Tidak. Tema Catalog berfokus pada tampilan produk yang cepat dimuat dan langsung mengarahkan pembeli berdiskusi ongkir/custom melalui WhatsApp.",
      },
      {
        question: "Apakah harga dapat dinegosiasikan untuk pembelian proyek?",
        answer: "Ya, pada produk berlabel Grosir atau Nego, pemilik usaha dapat menampilkan rentang harga yang transparan.",
      },
    ],
  },
  {
    slug: "resto",
    themeName: "Tema Resto",
    verticalLabel: "Restoran & Multi-Cabang",
    businessName: "Dapur Rempah Nusantara",
    tagline: "Masakan Rumahan Nusantara, Reservasi Meja & Katering Kotak di 3 Kota",
    description:
      "Contoh tampilan situs usaha kuliner dan outlet multi-cabang dengan daftar menu berharga jelas, kartu cabang (alamat, jam buka, tautan peta tanpa JS), dan layanan reservasi.",
    heroCtaLabel: "Reservasi Meja / Katering (Demo)",
    accentColor: "#9a3412",
    accentSecondary: "#176b51",
    surfaceTint: "#faf6f3",
    syntheticWhatsapp: "6281200000005",
    syntheticEmail: "demo-resto@contoh.punyasitus.test",
    syntheticAddress: "Jl. Kemang Raya Contoh No. 55, Jakarta Selatan (Alamat Simulasi)",
    city: "Jakarta Selatan",
    credentials: [
      { label: "Status Halal (Contoh)", value: "CONTOH-BPJPH-ID000000000" },
      { label: "Jumlah Cabang", value: "3 Outlet (Jakarta, Bandung, Surabaya)" },
      { label: "Layanan", value: "Makan di Tempat, Bungkus & Nasi Kotak" },
    ],
    highlights: [
      { label: "Jam Operasional", value: "Setiap Hari 10.00–21.30 WIB" },
      { label: "Kapasitas Grup", value: "Ruang VIP hingga 40 Tamu" },
      { label: "Katering Kantor", value: "Pemesanan H-1 via WhatsApp" },
    ],
    items: [
      {
        id: "resto-1",
        title: "Paket Nasi Liwet Komplit Ayam Bakar Rempah",
        category: "Menu Utama",
        priceLabel: formatIdr(58_000),
        priceIdr: 58_000,
        badge: "Favorit Keluarga",
        summary: "Nasi liwet teri medan, ayam kampung bakar kecap rempah, tahu tempe bacem, lalapan segar, dan sambal terasi.",
        specs: [
          { label: "Porsi", value: "1 Orang" },
          { label: "Tersedia", value: "Dine-in & Nasi Kotak" },
        ],
      },
      {
        id: "resto-2",
        title: "Sop Buntut Kuah Bening Rempah + Nasi Putih",
        category: "Menu Kuah",
        priceLabel: formatIdr(89_000),
        priceIdr: 89_000,
        summary: "Buntut sapi empuk dimasak perlahan dengan pala, cengkeh, wortel, kentang, emping, dan sambal hijau.",
        specs: [
          { label: "Porsi", value: "1 Orang" },
          { label: "Level Pedas", value: "Sambal Terpisah" },
        ],
      },
      {
        id: "resto-3",
        title: "Paket Tumpeng & Nasi Kotak Rapat (Min. 25 Box)",
        category: "Katering",
        priceLabel: `Mulai ${formatIdr(42_000)} / box`,
        badge: "Pesan H-1",
        summary: "Pilihan lauk rendang, ayam serundeng, atau ikan pesmol lengkap dengan buah potong dan air mineral.",
        specs: [
          { label: "Minimum Order", value: "25 Box" },
          { label: "Pengantaran", value: "Area Kota Sekitar Cabang" },
        ],
      },
    ],
    branches: [
      {
        name: "Cabang Kemang — Jakarta Selatan (Contoh)",
        city: "Jakarta Selatan",
        address: "Jl. Kemang Raya Contoh No. 55, Jakarta Selatan",
        hoursWeekday: "Senin–Jumat, 10.00–21.30 WIB",
        hoursWeekend: "Sabtu–Minggu, 09.30–22.00 WIB",
        syntheticPhone: "6281200000005",
        mapsQuery: "Kemang+Jakarta+Selatan",
      },
      {
        name: "Cabang Riau — Bandung (Contoh)",
        city: "Bandung",
        address: "Jl. L.L.R.E. Martadinata Contoh No. 72, Bandung",
        hoursWeekday: "Senin–Jumat, 10.00–21.00 WIB",
        hoursWeekend: "Sabtu–Minggu, 09.30–21.30 WIB",
        syntheticPhone: "6281200000005",
        mapsQuery: "Jalan+Riau+Bandung",
      },
      {
        name: "Cabang Darmo — Surabaya (Contoh)",
        city: "Surabaya",
        address: "Jl. Raya Darmo Contoh No. 114, Surabaya",
        hoursWeekday: "Senin–Jumat, 10.00–21.30 WIB",
        hoursWeekend: "Sabtu–Minggu, 10.00–22.00 WIB",
        syntheticPhone: "6281200000005",
        mapsQuery: "Darmo+Surabaya",
      },
    ],
    faq: [
      {
        question: "Apakah tautan peta cabang membutuhkan JavaScript?",
        answer: "Tidak. Setiap cabang menyediakan tautan alamat dan Google Maps statis yang tetap berfungsi cepat di koneksi seluler tanpa iframe berat.",
      },
      {
        question: "Apakah cabang ini benar-benar beroperasi?",
        answer: "Tidak. Dapur Rempah Nusantara adalah usaha contoh (simulasi) untuk mendemonstrasikan tema Resto PunyaSitus.",
      },
    ],
  },
  {
    slug: "dealer",
    themeName: "Tema Dealer",
    verticalLabel: "Showroom Kendaraan & Estimasi Cicilan Statis",
    businessName: "Showroom Mobil Prima Jaya",
    tagline: "Unit Kendaraan Inspeksi Transparan dengan Simulasi Cicilan Statis",
    description:
      "Contoh tampilan showroom mobil/motor dengan spesifikasi unit lengkap, status Tersedia/Terjual yang jelas, serta tabel estimasi cicilan statis tanpa JavaScript.",
    heroCtaLabel: "Jadwalkan Test Drive (Demo)",
    accentColor: "#111827",
    accentSecondary: "#176b51",
    surfaceTint: "#f4f5f7",
    syntheticWhatsapp: "6281200000006",
    syntheticEmail: "demo-dealer@contoh.punyasitus.test",
    syntheticAddress: "Jl. Otomotif Raya Contoh No. 120, Serpong, Tangerang (Alamat Simulasi)",
    city: "Tangerang",
    credentials: [
      { label: "Inspeksi Unit", value: "Laporan 120 Titik (Contoh)" },
      { label: "Status Dokumen", value: "BPKB & STNK Dicek Keabsahan" },
      { label: "Layanan", value: "Cash, Tukar Tambah & Simulasi Kredit" },
    ],
    highlights: [
      { label: "Kategori Unit", value: "MPV, SUV, Crossover & Niaga" },
      { label: "Transparansi", value: "Odometer & Riwayat Servis Terbuka" },
      { label: "Status Terjual", value: "Label TERJUAL Jelas di Katalog" },
    ],
    items: [
      {
        id: "dealer-1",
        title: "Toyota Avanza 1.5 G CVT (2024)",
        category: "MPV • Baru / Seperti Baru",
        priceLabel: formatIdr(268_000_000),
        priceIdr: 268_000_000,
        status: "available",
        badge: "Tersedia • Nego",
        summary: "Unit contoh MPV keluarga 7-penumpang, transmisi CVT halus, pajak aktif, riwayat servis bengkel resmi.",
        specs: [
          { label: "Tahun / Kondisi", value: "2024 / Bekas Terawat" },
          { label: "Jarak Tempuh", value: "11.400 km (Contoh)" },
          { label: "Transmisi / BBM", value: "Otomatis CVT / Bensin" },
          { label: "Kapasitas / Warna", value: "1.496 cc • Putih Mutiara" },
        ],
      },
      {
        id: "dealer-2",
        title: "Honda CR-V 1.5 Turbo Prestige (2023)",
        category: "SUV • Bekas",
        priceLabel: formatIdr(485_000_000),
        priceIdr: 485_000_000,
        status: "available",
        badge: "Tersedia",
        summary: "SUV 7-seater dengan panoramic sunroof, fitur keselamatan aktif, tangan pertama perorangan.",
        specs: [
          { label: "Tahun / Kondisi", value: "2023 / Bekas" },
          { label: "Jarak Tempuh", value: "18.900 km (Contoh)" },
          { label: "Transmisi / BBM", value: "Otomatis CVT / Bensin" },
          { label: "Lokasi Unit", value: "Showroom Serpong (Contoh)" },
        ],
      },
      {
        id: "dealer-3",
        title: "Mitsubishi Xpander Ultimate AT (2022)",
        category: "MPV • Bekas",
        priceLabel: formatIdr(242_000_000),
        priceIdr: 242_000_000,
        status: "sold",
        badge: "TERJUAL",
        summary: "Contoh tampilan unit yang sudah terjual — tetap tampil informatif sebagai arsip tanpa menampilkan tabel cicilan.",
        specs: [
          { label: "Tahun / Kondisi", value: "2022 / Bekas" },
          { label: "Jarak Tempuh", value: "31.200 km (Contoh)" },
          { label: "Transmisi / BBM", value: "Otomatis / Bensin" },
          { label: "Status", value: "TERJUAL" },
        ],
      },
    ],
    creditSimulation: DEALER_CREDIT_SIMULATION,
    faq: [
      {
        question: "Bagaimana tabel estimasi cicilan dihitung?",
        answer: "Tabel dihitung di server menggunakan aritmetika integer Rupiah (DP 20%/30%/40%, tenor 12–48 bulan) tanpa JavaScript dan hanya muncul untuk unit berstatus Tersedia dengan harga tetap.",
      },
      {
        question: "Apakah unit pada halaman ini benar-benar dijual?",
        answer: "Tidak. Seluruh kendaraan, harga OTR, dan simulasi kredit adalah data simulasi demo PunyaSitus.",
      },
    ],
  },
];

const DEMO_BY_SLUG: ReadonlyMap<DemoThemeSlug, DemoTenantFixture> = new Map(
  DEMO_TENANT_FIXTURES.map((item) => [item.slug, item]),
);

export function listDemoTenants(): readonly DemoTenantFixture[] {
  return DEMO_TENANT_FIXTURES;
}

export function getDemoTenantBySlug(slug: string | null | undefined): DemoTenantFixture | null {
  if (!slug) return null;
  const normalized = slug.trim().toLowerCase() as DemoThemeSlug;
  return DEMO_BY_SLUG.get(normalized) ?? null;
}

export function isDemoThemeSlug(slug: string): slug is DemoThemeSlug {
  return (DEMO_THEME_SLUGS as readonly string[]).includes(slug);
}

/**
 * Blocks any HTTP mutation (`POST`, `PUT`, `PATCH`, `DELETE`) targeting a synthetic demo route.
 * Returns a `403 DEMO_READ_ONLY` JSON response with `X-Robots-Tag: noindex, nofollow` and zero DB writes.
 */
export function guardDemoReadOnlyMethod(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return null;
  }
  return new Response(
    JSON.stringify({
      success: false,
      code: DEMO_READ_ONLY_ERROR_CODE,
      message:
        "Situs demo PunyaSitus bersifat hanya baca (read-only). Perubahan data tidak diizinkan.",
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-PunyaSitus-Demo": "read-only",
      },
    },
  );
}
