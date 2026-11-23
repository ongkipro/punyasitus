import { MARKETING_URLS } from "../marketing/constants.ts";
import { getHelpCategoryMeta, type HelpCategoryId } from "./categories.ts";
import type { HelpArticleRecord } from "./markdown.ts";

/**
 * Typed registry mapping every dashboard screen & section to its canonical Help Center `help_slug`
 * (REQ-104, PLAN §20.2, TASK-104).
 *
 * Build/test integrity check (`validateHelpRegistryIntegrity`) FAILS if any `helpSlug`
 * here points to a missing article under `apps/web/src/content/bantuan/`.
 */

export const HELP_CANONICAL_BASE_PATH = "/bantuan" as const;
export const HELP_MARKETING_ROUTE_PREFIX = "/marketing/bantuan" as const;

export interface DashboardHelpMappingEntry {
  readonly screenLabel: string;
  readonly helpSlug: string;
  readonly category: HelpCategoryId;
  readonly shortTitle: string;
  readonly shortSummary: string;
  readonly readingMinutes: number;
}

export const DASHBOARD_HELP_LINKS = {
  overview: {
    screenLabel: "Beranda & Ringkasan",
    helpSlug: "memulai-uji-coba-dan-daftar-akun",
    category: "mulai",
    shortTitle: "Memulai Uji Coba 7 Hari & Daftar Akun",
    shortSummary: "Langkah awal setelah mendaftar, batas uji coba 7 hari, dan cara menyiapkan situs pertama.",
    readingMinutes: 3,
  },
  onboarding: {
    screenLabel: "Panduan Awal (Onboarding)",
    helpSlug: "memilih-blueprint-dan-daftar-periksa-awal",
    category: "mulai",
    shortTitle: "Memilih Blueprint Bisnis & Checklist Awal",
    shortSummary: "Cara kerja 7 blueprint vertikal PunyaSitus dan membersihkan penanda CONTOH sebelum terbit.",
    readingMinutes: 3,
  },
  leads: {
    screenLabel: "Pesan Masuk (Leads)",
    helpSlug: "mengelola-pesan-masuk-dan-ekspor-csv",
    category: "kontak",
    shortTitle: "Mengelola Pesan Masuk & Ekspor CSV",
    shortSummary: "Membaca prospek dari formulir, mengekspor data ke CSV, dan menghapus pesan secara permanen.",
    readingMinutes: 3,
  },
  offering: {
    screenLabel: "Katalog Penawaran",
    helpSlug: "membuat-penawaran-pertama-layanan-produk",
    category: "konten",
    shortTitle: "Membuat Penawaran Pertama (Layanan, Produk, Tur, Kendaraan)",
    shortSummary: "Cara menambah penawaran, memilih format harga IDR, galeri foto, dan tombol aksi WhatsApp.",
    readingMinutes: 4,
  },
  offering_new: {
    screenLabel: "Tambah Penawaran Baru",
    helpSlug: "membuat-penawaran-pertama-layanan-produk",
    category: "konten",
    shortTitle: "Membuat Penawaran Pertama (Layanan, Produk, Tur, Kendaraan)",
    shortSummary: "Panduan mengisi kolom wajib penawaran agar tampil rapi di halaman katalog dan Google.",
    readingMinutes: 4,
  },
  pages: {
    screenLabel: "Halaman Situs",
    helpSlug: "menyusun-halaman-dan-bagian-konversi",
    category: "konten",
    shortTitle: "Menyusun Halaman & Bagian Konversi",
    shortSummary: "Mengatur urutan bagian dengan Naik/Turun, menyembunyikan bagian, dan Mode Fokus Landing Page.",
    readingMinutes: 3,
  },
  pages_editor: {
    screenLabel: "Editor Halaman",
    helpSlug: "menyusun-halaman-dan-bagian-konversi",
    category: "konten",
    shortTitle: "Menyusun Halaman & Bagian Konversi",
    shortSummary: "Menyimpan draf, memeriksa pratinjau, dan menerbitkan pembaruan halaman dengan aman.",
    readingMinutes: 3,
  },
  posts: {
    screenLabel: "Artikel Blog",
    helpSlug: "menulis-artikel-blog-ramah-seo",
    category: "konten",
    shortTitle: "Menulis Artikel Blog Ramah SEO",
    shortSummary: "Format tulisan, profil penulis, kategori, daftar isi otomatis, dan tanggal pembaruan artikel.",
    readingMinutes: 4,
  },
  media: {
    screenLabel: "Pustaka Media",
    helpSlug: "mengunggah-foto-webp-dan-video",
    category: "konten",
    shortTitle: "Mengunggah Foto WebP, Video Pendek & YouTube",
    shortSummary: "Batas ukuran 5 MB foto / 10 MB video, optimasi otomatis ke WebP, teks ALT, dan kuota penyimpanan.",
    readingMinutes: 3,
  },
  menus: {
    screenLabel: "Menu Navigasi",
    helpSlug: "mengatur-menu-navigasi-situs",
    category: "konten",
    shortTitle: "Mengatur Menu Navigasi Header & Footer",
    shortSummary: "Menambahkan tautan halaman, mengurutkan item menu, dan menjaga navigasi tetap ringkas.",
    readingMinutes: 2,
  },
  appearance: {
    screenLabel: "Tema & Tampilan",
    helpSlug: "mengganti-tema-dan-variasi-gaya",
    category: "tampilan-seo",
    shortTitle: "Mengganti Tema Vertikal & Variasi Gaya",
    shortSummary: "Beralih di antara 6 tema dan variasi gaya tanpa kehilangan konten, plus Mode Tercepat.",
    readingMinutes: 3,
  },
  preview: {
    screenLabel: "Pratinjau Draf",
    helpSlug: "pratinjau-draf-sebelum-terbit",
    category: "konten",
    shortTitle: "Pratinjau Draf Aman Sebelum Terbit",
    shortSummary: "Memeriksa tampilan ponsel dan desktop secara pribadi sebelum perubahan tampil ke publik.",
    readingMinutes: 2,
  },
  plugins: {
    screenLabel: "Plugin Situs",
    helpSlug: "mengelola-plugin-dan-seo-otomatis",
    category: "tampilan-seo",
    shortTitle: "Mengelola Plugin Resmi Gratis & Berbayar",
    shortSummary: "Memasang atau menonaktifkan plugin resmi seperti SEO & AI Autopilot tanpa kehilangan pengaturan.",
    readingMinutes: 3,
  },
  seo: {
    screenLabel: "SEO & Visibilitas AI",
    helpSlug: "mengoptimalkan-seo-dan-visibilitas-ai",
    category: "tampilan-seo",
    shortTitle: "Mengoptimalkan SEO & Visibilitas Asisten AI",
    shortSummary: "Cara kerja sitemap, robots.txt ramah pencari & AI, IndexNow, serta salin data Google Business Profile.",
    readingMinutes: 4,
  },
  settings: {
    screenLabel: "Pengaturan Situs",
    helpSlug: "mengatur-profil-bisnis-dan-whatsapp",
    category: "kontak",
    shortTitle: "Mengatur Profil Bisnis & Kontak WhatsApp",
    shortSummary: "Melengkapi identitas bisnis, jam operasional, kredensial opsional, dan nomor WhatsApp utama.",
    readingMinutes: 4,
  },
  settings_identity: {
    screenLabel: "Profil & Identitas Bisnis",
    helpSlug: "mengatur-profil-bisnis-dan-whatsapp",
    category: "kontak",
    shortTitle: "Mengatur Profil Bisnis & Kontak WhatsApp",
    shortSummary: "Mengisi nama bisnis, kategori usaha, logo, alamat, jam buka, dan pesan pembuka WhatsApp.",
    readingMinutes: 4,
  },
  settings_domains: {
    screenLabel: "Domain Kustom & DNS",
    helpSlug: "menghubungkan-domain-kustom-dan-dns",
    category: "domain",
    shortTitle: "Menghubungkan Domain Kustom (.id, .co.id, .com)",
    shortSummary: "Panduan record CNAME dan TXT verifikasi untuk domain baru, pindahan tanpa downtime, atau Cloudflare.",
    readingMinutes: 5,
  },
  settings_analytics: {
    screenLabel: "Analitik & Izin Cookie",
    helpSlug: "mengatur-analitik-dan-izin-cookie",
    category: "tampilan-seo",
    shortTitle: "Analitik Tanpa Cookie, GTM & Banner Izin",
    shortSummary: "Memahami statistik bawaan tanpa cookie dan cara aman memasang GTM atau Pixel setelah izin pengunjung.",
    readingMinutes: 3,
  },
  settings_members: {
    screenLabel: "Anggota Tim & Peran",
    helpSlug: "mengundang-anggota-tim-dan-peran",
    category: "keamanan-pemulihan",
    shortTitle: "Mengundang Anggota Tim & Memilih Peran",
    shortSummary: "Perbedaan peran Pemilik, Admin, dan Editor (maks 5 akun per situs) serta cara mencabut akses.",
    readingMinutes: 3,
  },
  billing: {
    screenLabel: "Tagihan & Langganan",
    helpSlug: "membayar-langganan-qris-dan-virtual-account",
    category: "pembayaran",
    shortTitle: "Membayar Langganan via QRIS & Virtual Account",
    shortSummary: "Cara memilih paket bulanan/tahunan, bayar dengan QRIS atau VA bank lokal, tanpa debit otomatis.",
    readingMinutes: 4,
  },
  receipts: {
    screenLabel: "Kuitansi Pembayaran",
    helpSlug: "mengunduh-kuitansi-pembayaran-pdf",
    category: "pembayaran",
    shortTitle: "Mengunduh Kuitansi Pembayaran PDF Bernomor",
    shortSummary: "Mengakses Bukti Pembayaran Layanan PDF resmi untuk keperluan pembukuan setelah transaksi lunas.",
    readingMinutes: 2,
  },
  service_status: {
    screenLabel: "Status Layanan & Pemulihan",
    helpSlug: "memulihkan-situs-terkunci-atau-ditangguhkan",
    category: "keamanan-pemulihan",
    shortTitle: "Memulihkan Situs Masa Tenggang, Terkunci, atau Ditangguhkan",
    shortSummary: "Penjelasan jadwal H+1 hingga H+45, ekspor CSV saat terkunci, dan cara mengaktifkan situs kembali.",
    readingMinutes: 4,
  },
  qr_code: {
    screenLabel: "Kode QR Situs",
    helpSlug: "membuat-kode-qr-untuk-situs-dan-penawaran",
    category: "tampilan-seo",
    shortTitle: "Membuat & Mengunduh Kode QR Gratis",
    shortSummary: "Mengunduh kode QR SVG/PNG untuk kartu nama, kemasan, atau katalog dengan pelacakan utm_source=qr.",
    readingMinutes: 2,
  },
  account_security: {
    screenLabel: "Keamanan Akun & 2FA",
    helpSlug: "keamanan-akun-google-dan-verifikasi-2fa",
    category: "keamanan-pemulihan",
    shortTitle: "Keamanan Akun Google & Verifikasi 2 Langkah (2FA)",
    shortSummary: "Mengaktifkan aplikasi autentikator TOTP, menyimpan kode cadangan, dan verifikasi ulang tindakan penting.",
    readingMinutes: 3,
  },
} as const satisfies Record<string, DashboardHelpMappingEntry>;

export type DashboardHelpScreenId = keyof typeof DASHBOARD_HELP_LINKS;

export const DASHBOARD_HELP_SCREEN_IDS = Object.keys(
  DASHBOARD_HELP_LINKS,
) as readonly DashboardHelpScreenId[];

export interface BuildHelpUrlOptions {
  /** Override base URL (defaults to `https://punyasitus.com/bantuan`). */
  readonly baseUrl?: string;
  /** Optional closed source tag (`"dashboard"` or `"marketing"`). */
  readonly from?: "dashboard" | "marketing";
}

export function buildHelpIndexUrl(options?: Pick<BuildHelpUrlOptions, "baseUrl">): string {
  const base = (options?.baseUrl ?? `${MARKETING_URLS.apexOrigin}${HELP_CANONICAL_BASE_PATH}`).replace(
    /\/+$/,
    "",
  );
  return base;
}

export function buildHelpArticleUrl(slug: string, options?: BuildHelpUrlOptions): string {
  const base = buildHelpIndexUrl(options);
  const safeSlug = encodeURIComponent(slug.trim());
  const suffix = options?.from ? `?from=${options.from}` : "";
  return `${base}/${safeSlug}${suffix}`;
}

export interface ResolvedDashboardHelpLink {
  readonly screenId: DashboardHelpScreenId;
  readonly screenLabel: string;
  readonly helpSlug: string;
  readonly categoryId: HelpCategoryId;
  readonly categoryLabel: string;
  readonly title: string;
  readonly summary: string;
  readonly readingMinutes: number;
  readonly href: string;
  readonly indexHref: string;
}

export function resolveDashboardHelpLink(
  screenId: DashboardHelpScreenId,
  options?: BuildHelpUrlOptions,
): ResolvedDashboardHelpLink {
  const entry = DASHBOARD_HELP_LINKS[screenId];
  const category = getHelpCategoryMeta(entry.category);
  return {
    screenId,
    screenLabel: entry.screenLabel,
    helpSlug: entry.helpSlug,
    categoryId: entry.category,
    categoryLabel: category.shortLabel,
    title: entry.shortTitle,
    summary: entry.shortSummary,
    readingMinutes: entry.readingMinutes,
    href: buildHelpArticleUrl(entry.helpSlug, {
      baseUrl: options?.baseUrl,
      from: options?.from ?? "dashboard",
    }),
    indexHref: buildHelpIndexUrl(options),
  };
}

export function filterHelpArticles(
  articles: readonly HelpArticleRecord[],
  filter: { readonly query?: string | null; readonly category?: HelpCategoryId | null },
): readonly HelpArticleRecord[] {
  const normalizedQuery = (filter.query ?? "").trim().toLowerCase();
  const terms = normalizedQuery
    ? normalizedQuery.split(/\s+/).filter((term) => term.length > 0)
    : [];

  return articles.filter((article) => {
    if (filter.category && article.category !== filter.category) {
      return false;
    }
    if (terms.length === 0) return true;
    const haystack = [
      article.title,
      article.summary,
      article.slug.replaceAll("-", " "),
      article.keywords.join(" "),
      article.plainText,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
