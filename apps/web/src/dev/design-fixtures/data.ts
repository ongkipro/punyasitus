import type { AdminSurface, LifecycleStatus } from "@/components/admin/navigation";

export type FixtureState =
  | "ready"
  | "loading"
  | "empty-first-run"
  | "empty-filtered"
  | "error"
  | "permission-denied"
  | "conflict";

export interface KpiItem {
  label: string;
  value: string;
  note: string;
}

export interface TableRowItem {
  id: string;
  primary: string;
  secondary: string;
  category: string;
  statusLabel: string;
  statusVariant: "success" | "warning" | "info" | "destructive" | "secondary";
  meta: string;
}

export interface SurfaceFixtureData {
  surface: AdminSurface;
  pageTitle: string;
  pageSubtitle: string;
  workspaceName: string;
  workspaceSubtitle: string;
  userDisplayName: string;
  offeringLabel?: string;
  unreadLeadsCount?: number;
  publicSiteHref?: string;
  primaryActionLabel: string;
  searchPlaceholder: string;
  kpis: KpiItem[];
  tableTitle: string;
  tableDescription: string;
  columns: [string, string, string, string];
  rows: TableRowItem[];
}

export const SURFACE_FIXTURES: Record<AdminSurface, SurfaceFixtureData> = {
  dashboard: {
    surface: "dashboard",
    pageTitle: "Ringkasan Situs",
    pageSubtitle: "Pantau pesan masuk, klik WhatsApp, dan status konten bisnis Anda.",
    workspaceName: "Klinik Gigi Sehat Bersama",
    workspaceSubtitle: "kliniksehat.situsku.click",
    userDisplayName: "drg. Budi Santoso",
    offeringLabel: "Layanan",
    unreadLeadsCount: 4,
    publicSiteHref: "https://kliniksehat.situsku.click",
    primaryActionLabel: "Tambah layanan",
    searchPlaceholder: "Cari pesan atau layanan...",
    kpis: [
      {
        label: "Pesan masuk (7 hari)",
        value: "18",
        note: "4 pesan belum dibalas hari ini",
      },
      {
        label: "Klik tombol WhatsApp",
        value: "64",
        note: "Sinyal minat pengunjung, bukan konfirmasi transaksi",
      },
      {
        label: "Halaman & layanan terbit",
        value: "12",
        note: "Semua tautan utama valid dan aktif",
      },
    ],
    tableTitle: "Pesan masuk terbaru",
    tableDescription: "Permintaan jadwal dan pertanyaan dari formulir kontak situs.",
    columns: ["Pengirim", "Layanan diminati", "Status", "Diterima"],
    rows: [
      {
        id: "lead-01",
        primary: "Siti Rahmawati",
        secondary: "0812-3456-7890",
        category: "Scaling & Pembersihan Karang",
        statusLabel: "Baru",
        statusVariant: "info",
        meta: "10 menit lalu",
      },
      {
        id: "lead-02",
        primary: "Hendra Wijaya",
        secondary: "0857-9912-3401",
        category: "Tambal Gigi Estetik",
        statusLabel: "Dibalas",
        statusVariant: "success",
        meta: "2 jam lalu",
      },
      {
        id: "lead-03",
        primary: "Dewi Kartika",
        secondary: "0813-8820-1145",
        category: "Konsultasi Behel",
        statusLabel: "Menunggu",
        statusVariant: "warning",
        meta: "Kemarin, 16:40",
      },
      {
        id: "lead-04",
        primary: "Agus Pratama",
        secondary: "0821-7703-5521",
        category: "Perawatan Saluran Akar",
        statusLabel: "Selesai",
        statusVariant: "secondary",
        meta: "20 Nov 2026",
      },
    ],
  },
  agency: {
    surface: "agency",
    pageTitle: "Daftar Situs Klien",
    pageSubtitle: "Kelola situs klien dalam satu ruang kerja agensi tanpa berpindah akun.",
    workspaceName: "Nusantara Digital Studio",
    workspaceSubtitle: "app.punyasitus.com/agency",
    userDisplayName: "Andi Wijaya",
    primaryActionLabel: "Buat situs klien",
    searchPlaceholder: "Cari nama klien atau domain...",
    kpis: [
      {
        label: "Situs klien aktif",
        value: "14",
        note: "Dari kuota 20 situs paket Agensi",
      },
      {
        label: "Perlu perpanjangan",
        value: "2",
        note: "1 masa tenggang, 1 berakhir dalam 5 hari",
      },
      {
        label: "Domain menunggu verifikasi",
        value: "1",
        note: "Menunggu propagasi TXT dan CNAME",
      },
    ],
    tableTitle: "Portofolio situs klien",
    tableDescription: "Pilih situs klien untuk masuk ke mode pengelolaan dengan bilah konteks klien.",
    columns: ["Nama klien", "Domain utama", "Status paket", "Diperbarui"],
    rows: [
      {
        id: "client-01",
        primary: "Klinik Gigi Sehat Bersama",
        secondary: "kliniksehat.situsku.click",
        category: "kliniksehat.id",
        statusLabel: "Aktif",
        statusVariant: "success",
        meta: "Hari ini, 09:15",
      },
      {
        id: "client-02",
        primary: "Bromo Explore Tour",
        secondary: "bromoexplore.situsku.click",
        category: "bromoexplore.co.id",
        statusLabel: "Uji coba",
        statusVariant: "info",
        meta: "Kemarin, 14:20",
      },
      {
        id: "client-03",
        primary: "Bengkel Mobil Jaya Abadi",
        secondary: "jayaabadi.situsku.click",
        category: "Belum ditautkan",
        statusLabel: "Masa tenggang",
        statusVariant: "warning",
        meta: "18 Nov 2026",
      },
      {
        id: "client-04",
        primary: "Catering Rasa Nusantara",
        secondary: "rasanusantara.situsku.click",
        category: "rasanusantara.id",
        statusLabel: "Terkunci",
        statusVariant: "destructive",
        meta: "10 Nov 2026",
      },
    ],
  },
  affiliate: {
    surface: "affiliate",
    pageTitle: "Ringkasan Afiliasi",
    pageSubtitle: "Pantau rujukan aktif, komisi terverifikasi, dan riwayat pencairan dana.",
    workspaceName: "Raka Pratama",
    workspaceSubtitle: "app.punyasitus.com/affiliate",
    userDisplayName: "Raka Pratama",
    primaryActionLabel: "Salin tautan referral",
    searchPlaceholder: "Cari kode rujukan atau transaksi...",
    kpis: [
      {
        label: "Klik rujukan (30 hari)",
        value: "412",
        note: "Dihitung dari tautan resmi punyasitus.com/?ref=raka",
      },
      {
        label: "Tenant berlangganan",
        value: "19",
        note: "16 aktif, 3 masih dalam masa garansi 14 hari",
      },
      {
        label: "Komisi siap cair",
        value: "Rp 3.420.000",
        note: "Batas minimum pencairan Rp 250.000",
      },
    ],
    tableTitle: "Riwayat komisi terbaru",
    tableDescription: "Komisi tersedia untuk pencairan setelah pembayaran tenant melewati masa verifikasi.",
    columns: ["Referensi", "Paket", "Status komisi", "Nominal"],
    rows: [
      {
        id: "aff-01",
        primary: "ref_202611_8841",
        secondary: "Tenant baru — Tahunan",
        category: "Paket Bisnis",
        statusLabel: "Siap cair",
        statusVariant: "success",
        meta: "Rp 350.000",
      },
      {
        id: "aff-02",
        primary: "ref_202611_8819",
        secondary: "Tenant baru — Bulanan",
        category: "Paket Agensi",
        statusLabel: "Verifikasi",
        statusVariant: "warning",
        meta: "Rp 480.000",
      },
      {
        id: "aff-03",
        primary: "ref_202610_8612",
        secondary: "Perpanjangan siklus 2",
        category: "Paket Bisnis",
        statusLabel: "Dicairkan",
        statusVariant: "secondary",
        meta: "Rp 350.000",
      },
    ],
  },
  console: {
    surface: "console",
    pageTitle: "Operasional Platform",
    pageSubtitle: "Pemantauan kesehatan tenant, status DNS/SSL domain, dan antrean pekerjaan latar.",
    workspaceName: "Console Operasional Platform",
    workspaceSubtitle: "console.punyasitus.com",
    userDisplayName: "Operator Platform",
    primaryActionLabel: "Periksa antrean",
    searchPlaceholder: "Cari tenant ID, handle, atau domain...",
    kpis: [
      {
        label: "Tenant aktif",
        value: "128",
        note: "12 uji coba, 3 masa tenggang, 1 ditangguhkan",
      },
      {
        label: "Domain menunggu SSL",
        value: "3",
        note: "Menampilkan status aktual Cloudflare, bukan hijau semu",
      },
      {
        label: "Antrean gagal (DLQ)",
        value: "0",
        note: "Pemrosesan media, email, dan webhook berjalan normal",
      },
    ],
    tableTitle: "Status verifikasi domain & tenant",
    tableDescription: "Setiap perubahan status tercatat pada audit log platform yang tidak dapat dihapus.",
    columns: ["Tenant / Handle", "Domain kustom", "Tahap verifikasi", "Diperiksa"],
    rows: [
      {
        id: "ops-01",
        primary: "kliniksehat",
        secondary: "tnt_01JFX20A9P",
        category: "kliniksehat.id",
        statusLabel: "SSL aktif",
        statusVariant: "success",
        meta: "2 menit lalu",
      },
      {
        id: "ops-02",
        primary: "bromoexplore",
        secondary: "tnt_01JFX21C4K",
        category: "bromoexplore.co.id",
        statusLabel: "Menunggu TXT DNS",
        statusVariant: "warning",
        meta: "5 menit lalu",
      },
      {
        id: "ops-03",
        primary: "kopisenja",
        secondary: "tnt_01JFX24R7M",
        category: "kopisenja.id",
        statusLabel: "Gagal validasi CAA",
        statusVariant: "destructive",
        meta: "14 menit lalu",
      },
    ],
  },
};

export const VALID_STATES: FixtureState[] = [
  "ready",
  "loading",
  "empty-first-run",
  "empty-filtered",
  "error",
  "permission-denied",
  "conflict",
];

export const VALID_LIFECYCLES: LifecycleStatus[] = [
  "active",
  "trial",
  "grace",
  "locked",
  "suspended",
];
