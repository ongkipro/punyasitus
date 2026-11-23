/**
 * Help Center category taxonomy & launch-topic contract (REQ-104, PLAN §20.2, TASK-104).
 */

export const HELP_CATEGORY_IDS = [
  "mulai",
  "domain",
  "konten",
  "kontak",
  "pembayaran",
  "tampilan-seo",
  "keamanan-pemulihan",
] as const;

export type HelpCategoryId = (typeof HELP_CATEGORY_IDS)[number];

export interface HelpCategoryMeta {
  readonly id: HelpCategoryId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly order: number;
}

export const HELP_CATEGORIES: readonly HelpCategoryMeta[] = [
  {
    id: "mulai",
    label: "Mulai & Uji Coba",
    shortLabel: "Mulai",
    description: "Pendaftaran akun, uji coba gratis 7 hari, blueprint vertikal, dan daftar periksa awal.",
    order: 1,
  },
  {
    id: "domain",
    label: "Domain & DNS",
    shortLabel: "Domain",
    description: "Menghubungkan domain .id/.co.id/.com, CNAME Cloudflare, SSL otomatis, dan migrasi tanpa downtime.",
    order: 2,
  },
  {
    id: "konten",
    label: "Penawaran, Halaman & Blog",
    shortLabel: "Konten",
    description: "Membuat katalog layanan/produk, menyusun halaman, menulis artikel blog, media WebP, dan menu.",
    order: 3,
  },
  {
    id: "kontak",
    label: "WhatsApp & Pesan Masuk",
    shortLabel: "WhatsApp & Prospek",
    description: "Profil bisnis, tombol WhatsApp, multi-cabang, formulir kustom, kotak pesan masuk, dan ekspor CSV.",
    order: 4,
  },
  {
    id: "pembayaran",
    label: "Pembayaran & Kuitansi",
    shortLabel: "Pembayaran",
    description: "Paket bulanan dan tahunan, QRIS, Virtual Account, kupon diskon, dan unduh kuitansi PDF bernomor.",
    order: 5,
  },
  {
    id: "tampilan-seo",
    label: "Tema, SEO, QR & Analitik",
    shortLabel: "Tema & SEO",
    description: "Tema vertikal, variasi gaya, plugin SEO & AI Autopilot, kode QR, dan analitik ramah privasi.",
    order: 6,
  },
  {
    id: "keamanan-pemulihan",
    label: "Akun, Tim & Pemulihan",
    shortLabel: "Akun & Pemulihan",
    description: "Keamanan akun Google & 2FA, peran anggota tim, serta pemulihan situs terkunci atau ditangguhkan.",
    order: 7,
  },
] as const;

const CATEGORY_MAP = new Map<HelpCategoryId, HelpCategoryMeta>(
  HELP_CATEGORIES.map((item) => [item.id, item]),
);

export function isHelpCategoryId(raw: unknown): raw is HelpCategoryId {
  return typeof raw === "string" && CATEGORY_MAP.has(raw as HelpCategoryId);
}

export function getHelpCategoryMeta(id: HelpCategoryId): HelpCategoryMeta {
  const found = CATEGORY_MAP.get(id);
  if (!found) {
    throw new Error(`Unknown help category: ${String(id)}`);
  }
  return found;
}

/**
 * Mandatory launch topics enumerated in REQ-104 & TASK-104.
 */
export const REQUIRED_HELP_LAUNCH_TOPICS = [
  "signup",
  "domain",
  "offering",
  "whatsapp",
  "payment",
  "receipts",
  "leads",
] as const;

export type HelpLaunchTopic = (typeof REQUIRED_HELP_LAUNCH_TOPICS)[number];

export const MIN_HELP_ARTICLE_COUNT = 20 as const;
