export type DnsEmailPathId =
  | "cloudflare_dns"
  | "registrar_forwarding"
  | "paid_mailbox";

export interface OfficialGuideLink {
  readonly label: string;
  readonly href: string;
  readonly provider: string;
  readonly description: string;
}

export interface DnsEmailPathGuide {
  readonly id: DnsEmailPathId;
  readonly shortLabel: string;
  readonly code: string;
  readonly badge: string;
  readonly title: string;
  readonly dnsHostSummary: string;
  readonly bestFor: string;
  readonly summary: string;
  readonly requirementCallout?: {
    readonly testId: string;
    readonly title: string;
    readonly body: string;
  };
  readonly steps: readonly string[];
  readonly notes: readonly string[];
  readonly officialLinks: readonly OfficialGuideLink[];
}

export interface DnsRecordPreservationItem {
  readonly recordType: string;
  readonly hostExample: string;
  readonly role: string;
  readonly action: string;
}

/**
 * Strict allowlist of official documentation & registry domains linked from this guide.
 * Never link to blogs, affiliate links, or unofficial third-party resellers (REQ-071).
 */
export const OFFICIAL_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  "developers.cloudflare.com",
  "pandi.id",
  "www.namecheap.com",
  "kb.porkbun.com",
  "support.google.com",
  "learn.microsoft.com",
  "www.zoho.com",
]);

export function isOfficialProviderUrl(href: string): boolean {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "https:") return false;
    if (parsed.search.length > 0) return false;
    return OFFICIAL_PROVIDER_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const DOMAIN_PURCHASE_OVERVIEW = {
  title: "1. Siapkan Nama Domain Milik Bisnis Anda Sendiri",
  summary:
    "PunyaSitus tidak menjual atau membeli domain atas nama pelanggan. Beli domain langsung di akun registrar milik Anda sendiri agar kendali penuh atas kepemilikan, perpanjangan, dan DNS selalu berada di tangan Anda.",
  tips: [
    "Untuk domain Indonesia (.id, .co.id, .biz.id), gunakan registrar resmi yang terakreditasi PANDI.",
    "Untuk domain global (.com, .net, .org), Anda dapat menggunakan registrar resmi seperti Cloudflare Registrar atau registrar tepercaya pilihan Anda.",
    "Gunakan email pemilik bisnis yang aktif saat mendaftar registrar dan aktifkan verifikasi 2 langkah (2FA) pada akun registrar.",
    "Setelah domain aktif di registrar, Anda dapat menghubungkan www.bisnisanda.id (disarankan) ke PunyaSitus melalui Pengaturan > Domain Kustom.",
  ],
  officialLinks: [
    {
      label: "PANDI — Registri Resmi Domain .id",
      href: "https://pandi.id/",
      provider: "PANDI",
      description: "Informasi resmi ekstensi domain .id dan daftar registrar terakreditasi di Indonesia.",
    },
    {
      label: "Dokumentasi Cloudflare Registrar",
      href: "https://developers.cloudflare.com/registrar/",
      provider: "Cloudflare",
      description: "Panduan resmi pendaftaran dan pengelolaan domain di Cloudflare Registrar.",
    },
  ] satisfies readonly OfficialGuideLink[],
} as const;

export const DNS_EMAIL_PATHS: readonly DnsEmailPathGuide[] = [
  {
    id: "cloudflare_dns",
    shortLabel: "Cloudflare DNS",
    code: "Jalur A",
    badge: "Gratis · Forwarding",
    title: "Domain di Cloudflare DNS (Cloudflare Email Routing)",
    dnsHostSummary: "DNS dikelola di Cloudflare (*.ns.cloudflare.com)",
    bestFor:
      "Cocok untuk bisnis yang ingin alamat profesional seperti info@bisnisanda.id diteruskan otomatis ke kotak masuk email yang sudah ada (mis. Gmail) tanpa biaya bulanan mailbox.",
    summary:
      "Cloudflare Email Routing menerima email yang dikirim ke alamat bisnis Anda (seperti info@ atau sales@) lalu meneruskannya ke alamat inbox pribadi/tim yang sudah terverifikasi.",
    requirementCallout: {
      testId: "cloudflare-dns-requirement",
      title: "Syarat Wajib: Cloudflare Email Routing Membutuhkan Cloudflare DNS",
      body: "Cloudflare Email Routing hanya dapat digunakan jika domain Anda sudah memakai Cloudflare DNS (nameserver domain di registrar diarahkan ke nameserver Cloudflare). Fitur ini tidak berjalan apabila DNS domain masih dikelola di registrar lain.",
    },
    steps: [
      "Pastikan domain Anda sudah ditambahkan ke akun Cloudflare milik Anda dan nameserver di registrar telah diarahkan ke Cloudflare DNS (Full Setup).",
      "Di dashboard Cloudflare, buka menu Email > Email Routing lalu ikuti wizard aktivasi agar Cloudflare memasang record MX dan TXT (SPF) secara otomatis.",
      "Tambahkan alamat tujuan (Destination address), misalnya email Gmail bisnis Anda, lalu klik tautan verifikasi yang dikirim Cloudflare ke kotak masuk tersebut.",
      "Buat alamat kustom (Custom address) seperti info@bisnisanda.id dan arahkan ke alamat tujuan yang sudah terverifikasi.",
      "Uji dengan mengirim email dari akun lain ke info@bisnisanda.id untuk memastikan penerusan berjalan lancar.",
    ],
    notes: [
      "Cloudflare Email Routing hanya meneruskan email masuk ke inbox yang sudah ada — tidak menyediakan kotak surat (mailbox) mandiri atau penyimpanan email.",
      "Jika Anda ingin mengirim dan membalas langsung dari alamat @bisnisanda.id dengan kotak masuk penuh, gunakan Jalur C (Penyedia Kotak Surat Berbayar).",
      "Saat menghubungkan website di Pengaturan > Domain Kustom, pilih mode Domain Sudah di Cloudflare (O2O) dan jangan hapus record MX/TXT milik Email Routing.",
    ],
    officialLinks: [
      {
        label: "Dokumentasi Resmi Cloudflare Email Routing",
        href: "https://developers.cloudflare.com/email-routing/",
        provider: "Cloudflare",
        description: "Panduan resmi aktivasi, konfigurasi alamat kustom, dan batas layanan Cloudflare Email Routing.",
      },
      {
        label: "Panduan Full DNS Setup di Cloudflare",
        href: "https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/",
        provider: "Cloudflare",
        description: "Langkah resmi memindahkan pengelolaan DNS (nameserver) domain Anda ke Cloudflare.",
      },
    ],
  },
  {
    id: "registrar_forwarding",
    shortLabel: "Registrar Forwarding",
    code: "Jalur B",
    badge: "Bawaan Registrar",
    title: "Penerusan Email (Email Forwarding) dari Registrar Domain",
    dnsHostSummary: "DNS tetap dikelola di registrar tempat domain dibeli",
    bestFor:
      "Cocok bila DNS domain tetap berada di registrar (tidak pindah ke Cloudflare) dan registrar Anda sudah menyediakan fitur email forwarding bawaan.",
    summary:
      "Beberapa registrar domain menyediakan fitur penerusan email bawaan sehingga email ke info@bisnisanda.id diteruskan ke kotak masuk yang sudah Anda miliki tanpa perlu memindahkan nameserver.",
    steps: [
      "Masuk langsung ke panel akun registrar tempat Anda membeli domain (PunyaSitus tidak pernah meminta login registrar Anda).",
      "Periksa apakah registrar Anda menyediakan fitur Email Forwarding / Redirect Email pada pengaturan domain.",
      "Aktifkan fitur penerusan email dan buat aturan penerusan, misalnya info@bisnisanda.id diteruskan ke kotak masuk aktif Anda.",
      "Pastikan record MX dan TXT/SPF bawaan fitur forwarding registrar terpasang sesuai petunjuk resmi registrar tersebut.",
      "Kirim email uji coba dari alamat lain untuk memverifikasi bahwa email masuk dengan baik sebelum dipublikasikan di website.",
    ],
    notes: [
      "Tidak semua registrar menyediakan email forwarding gratis; jika registrar Anda tidak menyediakannya, pertimbangkan Jalur A (pindah DNS ke Cloudflare) atau Jalur C (mailbox berbayar).",
      "Seperti Cloudflare Email Routing, fitur forwarding registrar biasanya hanya untuk menerima/meneruskan email masuk, bukan kotak surat penuh.",
      "Saat menambahkan record CNAME website PunyaSitus di panel DNS registrar, biarkan seluruh record MX dan TXT email tetap utuh.",
    ],
    officialLinks: [
      {
        label: "Dokumentasi Resmi Namecheap — Email Forwarding",
        href: "https://www.namecheap.com/support/knowledgebase/article.aspx/308/2214/how-to-set-up-free-email-forwarding/",
        provider: "Namecheap",
        description: "Contoh panduan resmi pengaturan penerusan email bawaan pada registrar Namecheap.",
      },
      {
        label: "Dokumentasi Resmi Porkbun — Email Forwarding",
        href: "https://kb.porkbun.com/article/26-how-to-set-up-email-forwarding",
        provider: "Porkbun",
        description: "Contoh panduan resmi pengaturan email forwarding pada registrar Porkbun.",
      },
    ],
  },
  {
    id: "paid_mailbox",
    shortLabel: "Mailbox Berbayar",
    code: "Jalur C",
    badge: "Kotak Surat Penuh",
    title: "Penyedia Kotak Surat Bisnis Berbayar (Google Workspace, Microsoft 365, Zoho Mail)",
    dnsHostSummary: "Kompatibel dengan Cloudflare DNS maupun DNS registrar",
    bestFor:
      "Direkomendasikan untuk bisnis yang membutuhkan kotak masuk dan kirim penuh (@bisnisanda.id), banyak akun tim, kalender, dan reputasi pengiriman email terbaik.",
    summary:
      "Layanan email bisnis berbayar memberikan kotak surat mandiri untuk setiap anggota tim lengkap dengan dukungan resmi MX, SPF, DKIM, dan DMARC — dikelola langsung di akun penyedia email pilihan Anda.",
    steps: [
      "Daftar akun langsung di penyedia kotak surat pilihan Anda (misalnya Google Workspace, Microsoft 365, atau Zoho Mail).",
      "Lakukan verifikasi kepemilikan domain dengan menambahkan record TXT verifikasi yang diberikan penyedia email ke panel DNS Anda.",
      "Tambahkan seluruh record MX resmi dari penyedia email, serta lengkapi record keamanan TXT SPF, DKIM, dan DMARC sesuai dokumentasi resmi mereka.",
      "Buat alamat email bisnis untuk tim Anda (misalnya info@, finance@, atau nama@bisnisanda.id) dan uji kirim-terima email.",
      "Anda tetap dapat menghubungkan website PunyaSitus pada domain yang sama tanpa memengaruhi layanan email selama record MX/SPF/DKIM/DMARC tidak diubah.",
    ],
    notes: [
      "Langganan kotak surat dibayarkan dan dikelola langsung pada penyedia email pilihan Anda — terpisah dari langganan website PunyaSitus.",
      "PunyaSitus tidak menyediakan mailbox, tidak mengakses isi email Anda, dan tidak pernah meminta kata sandi atau kunci API akun email Anda.",
      "Jika Anda menggunakan domain root (apex) sekaligus email bisnis, gunakan www.bisnisanda.id sebagai domain utama website atau pastikan penyedia DNS mendukung CNAME flattening agar record MX pada root domain tidak terganggu.",
    ],
    officialLinks: [
      {
        label: "Google Workspace — Panduan Konfigurasi MX",
        href: "https://support.google.com/a/answer/140034",
        provider: "Google Workspace",
        description: "Dokumentasi resmi Google untuk menyiapkan record MX email bisnis pada domain kustom.",
      },
      {
        label: "Microsoft 365 — Tambah Domain & Konfigurasi DNS",
        href: "https://learn.microsoft.com/en-us/microsoft-365/admin/setup/add-domain",
        provider: "Microsoft 365",
        description: "Dokumentasi resmi Microsoft untuk menghubungkan domain dan mengatur DNS Exchange Online.",
      },
      {
        label: "Zoho Mail — Verifikasi Domain & Pengaturan DNS",
        href: "https://www.zoho.com/mail/help/adminconsole/domain-verification.html",
        provider: "Zoho Mail",
        description: "Dokumentasi resmi Zoho Mail untuk verifikasi domain dan pemasangan record MX/SPF/DKIM.",
      },
    ],
  },
] as const;

export const DNS_PRESERVATION_ITEMS: readonly DnsRecordPreservationItem[] = [
  {
    recordType: "MX",
    hostExample: "@ (root domain)",
    role: "Mengarahkan email masuk ke server penyedia email Anda.",
    action: "Jangan dihapus atau ditimpa saat menambah CNAME website.",
  },
  {
    recordType: "TXT (SPF)",
    hostExample: "@ (v=spf1 ...)",
    role: "Menentukan server resmi yang diizinkan mengirim email atas nama domain Anda.",
    action: "Pertahankan tetap utuh; jangan diganti saat verifikasi website.",
  },
  {
    recordType: "TXT / CNAME (DKIM)",
    hostExample: "selector._domainkey",
    role: "Tanda tangan kriptografi keaslian email agar tidak masuk folder spam.",
    action: "Biarkan tetap aktif sesuai panduan penyedia email Anda.",
  },
  {
    recordType: "TXT (DMARC)",
    hostExample: "_dmarc",
    role: "Kebijakan perlindungan terhadap pemalsuan pengirim (spoofing) domain.",
    action: "Jangan dihapus; terpisah dari record CNAME website.",
  },
] as const;

export function getAllGuideOfficialLinks(): readonly OfficialGuideLink[] {
  return [
    ...DOMAIN_PURCHASE_OVERVIEW.officialLinks,
    ...DNS_EMAIL_PATHS.flatMap((path) => path.officialLinks),
  ];
}
