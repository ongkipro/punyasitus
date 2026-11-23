/* global process, console, document, window, getComputedStyle, URL */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const webDir = path.join(root, "apps/web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));
const { chromium } = requireFromWeb("playwright-core");
const astroEntryUrl = pathToFileURL(requireFromWeb.resolve("astro")).href;

const screenshotDir = process.env.TASK013_SCREENSHOT_DIR || "";

const PLATFORM_THEMES = [
  { id: "compro", primary: "#176b51", radius: "8px" },
  { id: "sales", primary: "#1e40af", radius: "8px" },
  { id: "travel", primary: "#0f5c5c", radius: "10px" },
  { id: "catalog", primary: "#1d4ed8", radius: "6px" },
  { id: "resto", primary: "#9a3412", radius: "10px" },
  { id: "dealer", primary: "#1e293b", radius: "4px" },
];

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Generates clean local SVG artwork served from the test fixture static server
 * so Playwright screenshots show realistic photography/illustration placeholders
 * with ZERO external network dependencies.
 */
function createFixtureArtwork(publicMediaDir) {
  fs.mkdirSync(publicMediaDir, { recursive: true });
  const svgs = [
    {
      name: "hero-office.svg",
      bg: "#0f4c5c",
      accent: "#176b51",
      title: "PT Nusantara Prima",
      subtitle: "Konsultan & Solusi Usaha Indonesia",
    },
    {
      name: "offering-1.svg",
      bg: "#1e3a5f",
      accent: "#2563eb",
      title: "Audit & Strategi",
      subtitle: "Layanan Korporat B2B",
    },
    {
      name: "offering-2.svg",
      bg: "#115e59",
      accent: "#0d9488",
      title: "Paket Wisata 3H2M",
      subtitle: "Yogyakarta & Jawa Tengah",
    },
    {
      name: "offering-3.svg",
      bg: "#1e293b",
      accent: "#b91c1c",
      title: "Showroom Unit 2023",
      subtitle: "Inspeksi 160 Titik Resmi",
    },
    {
      name: "gallery-1.svg",
      bg: "#27374d",
      accent: "#526d82",
      title: "Dokumentasi Proyek",
      subtitle: "Jakarta Selatan · 2026",
    },
    {
      name: "gallery-2.svg",
      bg: "#3f2e24",
      accent: "#9a3412",
      title: "Ruang Layanan Klien",
      subtitle: "Cabang Utama & Konsultasi",
    },
  ];

  const escapeXml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  for (const item of svgs) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="${item.bg}"/>
  <rect x="64" y="64" width="1072" height="672" rx="24" fill="${item.accent}" fill-opacity="0.32" stroke="#ffffff" stroke-opacity="0.22" stroke-width="2"/>
  <circle cx="980" cy="200" r="140" fill="#ffffff" fill-opacity="0.08"/>
  <circle cx="220" cy="610" r="190" fill="#ffffff" fill-opacity="0.06"/>
  <text x="112" y="385" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="54" font-weight="700">${escapeXml(item.title)}</text>
  <text x="112" y="452" fill="#e2e8f0" font-family="system-ui, -apple-system, sans-serif" font-size="30" font-weight="500">${escapeXml(item.subtitle)}</text>
</svg>`;
    fs.writeFileSync(path.join(publicMediaDir, item.name), svg, "utf8");
  }
}

/**
 * Compiles the REAL `Layout.astro`, `SectionRenderer.astro`, `section-registry.ts`,
 * and ALL 10 section components via Astro build in an isolated temp directory.
 */
async function buildRealSectionFixtures() {
  const astroWorkBase = path.join(webDir, ".astro");
  fs.mkdirSync(astroWorkBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(astroWorkBase, "t013-e2e-"));
  const srcDir = path.join(tmpRoot, "src");
  const pagesDir = path.join(srcDir, "pages");
  const publicDir = path.join(tmpRoot, "public");
  const outDir = path.join(tmpRoot, "dist");
  const cacheDir = path.join(tmpRoot, "cache");
  fs.mkdirSync(pagesDir, { recursive: true });
  createFixtureArtwork(path.join(publicDir, "media/t/demo"));

  const layoutImport = path.join(webDir, "src/themes/default/Layout.astro");
  const rendererImport = path.join(webDir, "src/themes/default/sections/SectionRenderer.astro");
  const publicDataImport = path.join(webDir, "src/core/public-data.ts");

  // Shared unified section data module used verbatim across ALL 6 themes to prove lossless theme switching!
  fs.writeFileSync(
    path.join(srcDir, "fixture-data.ts"),
    `import { buildSafeThemeStyleBlock } from ${JSON.stringify(publicDataImport)};

export const UNIFIED_HOME_SECTIONS = [
  {
    id: "hero-utama",
    type: "hero",
    enabled: true,
    config: {
      eyebrow: "Mitra Usaha Terpercaya",
      heading: "Bangun Kredibilitas Usaha dengan Halaman Cepat & Terstruktur",
      subheading:
        "Satu susunan konten terpadu yang dapat berganti tema tanpa kehilangan data, berjalan optimal tanpa JavaScript, dan siap menerima pertanyaan via WhatsApp.",
      primaryCta: {
        label: "Konsultasi WhatsApp",
        href: "https://wa.me/6281234567890",
        variant: "whatsapp",
        openInNewTab: true,
      },
      secondaryCta: {
        label: "Lihat Penawaran",
        href: "#penawaran",
        variant: "secondary",
      },
      media: {
        src: "/media/t/demo/hero-office.svg",
        alt: "Ilustrasi ruang kerja PT Nusantara Prima",
        width: 1200,
        height: 800,
      },
      highlights: ["Tanpa JavaScript Wajib", "Kontras WCAG AA", "Ganti Tema Tanpa Hilang Data"],
    },
  },
  {
    id: "keunggulan",
    type: "features",
    enabled: true,
    config: {
      eyebrow: "Keunggulan Utama",
      heading: "Dirancang untuk Kebutuhan Bisnis Indonesia",
      subheading: "Struktur halaman modular yang mudah dikelola oleh pemilik usaha maupun tim editor.",
      columns: 3,
      items: [
        {
          title: "Ringan di Jaringan 4G",
          description: "HTML server-rendered murni tanpa beban runtime berat untuk pengunjung seluler.",
          badge: "Performa",
        },
        {
          title: "Harga Jujur & Transparan",
          description: "Mendukung harga tetap, mulai dari, rentang, hingga hubungi untuk harga.",
          badge: "Katalog",
        },
        {
          title: "Kepatuhan Regulasi",
          description: "Testimoni kategori kesehatan otomatis dinonaktifkan beserta peringatan Permenkes.",
          badge: "Kepatuhan",
        },
      ],
    },
  },
  {
    id: "penawaran",
    type: "offerings_grid",
    enabled: true,
    config: {
      eyebrow: "Penawaran Pilihan",
      heading: "Layanan, Paket Tur & Unit Tersedia",
      subheading: "Seluruh penawaran terhubung langsung ke WhatsApp atau halaman informasi tanpa keranjang rumit.",
      limit: 6,
      items: [
        {
          slug: "audit-operasional-bisnis",
          offeringType: "service",
          title: "Audit Operasional & SOP Perusahaan",
          summary: "Pemetaan alur kerja, standar mutu, dan pendampingan implementasi selama 4 minggu.",
          coverImage: {
            src: "/media/t/demo/offering-1.svg",
            alt: "Layanan audit operasional perusahaan",
            width: 1200,
            height: 800,
          },
          priceMode: "from",
          price: 3500000,
          negotiable: true,
          badge: "Terlaris",
          categoryName: "Layanan B2B",
          ctaKind: "whatsapp",
          whatsappPhone: "081234567890",
        },
        {
          slug: "paket-wisata-yogyakarta-3h2m",
          offeringType: "tour",
          title: "Paket Wisata Yogyakarta 3 Hari 2 Malam",
          summary: "Hotel bintang 4, transportasi AC pribadi, tiket wisata utama, dan pemandu resmi.",
          coverImage: {
            src: "/media/t/demo/offering-2.svg",
            alt: "Paket wisata Yogyakarta 3 hari 2 malam",
            width: 1200,
            height: 800,
          },
          priceMode: "range",
          price: 1850000,
          priceMax: 2650000,
          categoryName: "Paket Tur",
          metaLine: "3 Hari 2 Malam · Keberangkatan Akhir Pekan",
          ctaKind: "whatsapp",
          whatsappPhone: "081234567890",
        },
        {
          slug: "suv-keluarga-2023-at",
          offeringType: "vehicle",
          title: "SUV Keluarga 2023 Automatic",
          summary: "Riwayat servis bengkel resmi, lolos inspeksi 160 titik, pajak aktif.",
          coverImage: {
            src: "/media/t/demo/offering-3.svg",
            alt: "Unit SUV keluarga tahun 2023",
            width: 1200,
            height: 800,
          },
          priceMode: "fixed",
          price: 345000000,
          originalAmount: 360000000,
          unitStatus: "available",
          categoryName: "Kendaraan",
          metaLine: "2023 · Automatic · Bensin · 18.000 km",
          ctaKind: "inquiry",
          ctaHref: "#kontak",
        },
      ],
    },
  },
  {
    id: "tentang-kami",
    type: "about",
    enabled: true,
    config: {
      eyebrow: "Tentang Perusahaan",
      heading: "Pengalaman Nyata Mendampingi UMKM & Korporasi",
      bodyHtml:
        "<p>Sejak 2016 kami membantu pelaku usaha membangun kehadiran digital yang rapi, jujur, dan mudah dihubungi pelanggan.</p><p>Setiap proyek dikerjakan dengan dokumentasi terbuka dan standar aksesibilitas yang jelas.</p><script>window.__t013RichTextXss=true</script>",
      milestones: [
        { value: "10+", label: "Tahun Beroperasi" },
        { value: "450+", label: "Klien Aktif" },
        { value: "6", label: "Tema Terpadu" },
      ],
    },
  },
  {
    id: "galeri-dokumentasi",
    type: "gallery",
    enabled: true,
    config: {
      eyebrow: "Galeri",
      heading: "Dokumentasi Proyek & Video",
      columns: 3,
      items: [
        {
          kind: "image",
          src: "/media/t/demo/gallery-1.svg",
          alt: "Dokumentasi proyek ruang kerja",
          width: 1200,
          height: 800,
          caption: "Implementasi ruang layanan klien di Jakarta Selatan",
        },
        {
          kind: "image",
          src: "/media/t/demo/gallery-2.svg",
          alt: "Dokumentasi cabang operasional",
          width: 1200,
          height: 800,
          caption: "Area konsultasi dan ruang tunggu pelanggan",
        },
        {
          kind: "youtube",
          videoId: "dQw4w9WgXcQ",
          title: "Video Profil Operasional Kami",
          caption: "Pratinjau video tanpa koneksi otomatis ke pihak ketiga",
        },
      ],
    },
  },
  {
    id: "testimoni-klien",
    type: "testimonials",
    config: {
      eyebrow: "Testimoni",
      heading: "Tanggapan Klien Kami",
      items: [
        {
          quote: "Komunikasi tim sangat jelas sejak awal, hasil akhir sesuai jadwal yang disepakati.",
          authorName: "Rina Kartika",
          authorRole: "Manajer Operasional",
          contextLabel: "Jakarta",
        },
        {
          quote: "Pelanggan jauh lebih mudah melihat daftar harga dan langsung bertanya lewat WhatsApp.",
          authorName: "Hendra Wijaya",
          authorRole: "Pemilik Usaha",
          contextLabel: "Bandung",
        },
        {
          quote: "Tampilan rapi di ponsel maupun laptop tanpa loading yang lambat.",
          authorName: "Siti Rahmawati",
          authorRole: "Koordinator Pemasaran",
          contextLabel: "Surabaya",
        },
      ],
    },
  },
  {
    id: "faq-umum",
    type: "faq",
    enabled: true,
    config: {
      eyebrow: "Pertanyaan Umum",
      heading: "Informasi yang Sering Ditanyakan",
      items: [
        {
          question: "Apakah isi halaman hilang jika saya mengganti tema?",
          answer:
            "Tidak. Seluruh bagian halaman menggunakan satu registri terpadu sehingga perpindahan antar 6 tema platform berlangsung tanpa kehilangan data.",
          defaultOpen: false,
        },
        {
          question: "Apakah halaman tetap bisa diakses jika JavaScript dinonaktifkan?",
          answer:
            "Ya. Navigasi, akordeon FAQ, tautan WhatsApp, serta seluruh informasi penawaran tetap berfungsi penuh tanpa JavaScript.",
          defaultOpen: false,
        },
      ],
    },
  },
  {
    id: "artikel-terbaru",
    type: "blog_latest",
    enabled: true,
    config: {
      eyebrow: "Blog & Panduan",
      heading: "Artikel Terbaru",
      limit: 3,
      posts: [
        {
          slug: "strategi-katalog-whatsapp-efektif",
          title: "Menyusun Katalog Penawaran yang Jelas untuk Pelanggan WhatsApp",
          excerpt: "Cara menyajikan informasi harga dan spesifikasi agar calon klien lebih cepat mengambil keputusan.",
          categoryName: "Panduan",
          authorName: "Tim Editorial",
          publishedAt: "2026-11-12T08:00:00Z",
          readingTimeMinutes: 4,
        },
        {
          slug: "pentingnya-kecepatan-situs-di-jaringan-seluler",
          title: "Mengapa Kecepatan Muat di Ponsel Menentukan Kepercayaan Klien",
          excerpt: "Mengurangi skrip yang tidak perlu membantu halaman terbuka cepat di jaringan 4G.",
          categoryName: "Teknologi",
          authorName: "Tim Editorial",
          publishedAt: "2026-11-08T08:00:00Z",
          readingTimeMinutes: 3,
        },
      ],
    },
  },
  {
    id: "ajakan-aksi",
    type: "cta_banner",
    enabled: true,
    config: {
      eyebrow: "Mulai Diskusi",
      heading: "Butuh Penawaran Khusus untuk Usaha Anda?",
      subheading: "Hubungi tim kami pada jam operasional untuk konsultasi tanpa komitmen.",
      primaryCta: {
        label: "Hubungi via WhatsApp",
        href: "https://wa.me/6281234567890",
        variant: "whatsapp",
        openInNewTab: true,
      },
      secondaryCta: {
        label: "Lihat Alamat Kantor",
        href: "#kontak",
        variant: "secondary",
      },
    },
  },
  {
    id: "kontak",
    type: "contact_location",
    enabled: true,
    config: {
      eyebrow: "Kontak & Lokasi",
      heading: "Kunjungi Kantor atau Cabang Kami",
      address: "Jl. Jenderal Sudirman No. 45, Jakarta Selatan 12190",
      weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
      holidayHours: "Sabtu–Minggu & Hari Libur Nasional Tutup",
      phone: "+6281234567890",
      email: "halo@nusantara-prima.id",
      whatsappPhone: "081234567890",
      mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
      branches: [
        {
          name: "Cabang Bandung",
          address: "Jl. Asia Afrika No. 88, Bandung",
          weekdayHours: "Senin–Sabtu 09.00–17.00 WIB",
          mapsUrl: "https://maps.google.com/?q=-6.9218,107.6071",
          whatsappPhone: "081298765432",
        },
      ],
    },
  },
];

export const STATIC_PAGE_SECTIONS = [
  {
    id: "hero-tentang",
    type: "hero",
    enabled: true,
    config: {
      eyebrow: "Halaman Statis",
      heading: "Profil & Standar Pelayanan Kami",
      subheading: "Halaman /{pageSlug} menggunakan registri seksi terpadu yang sama dengan beranda.",
      primaryCta: {
        label: "Hubungi Tim",
        href: "#kontak-halaman",
        variant: "primary",
      },
    },
  },
  {
    id: "cerita-kami",
    type: "rich_text",
    enabled: true,
    config: {
      heading: "Komitmen Transparansi",
      bodyHtml: "<p>Seluruh halaman statis mendukung susunan seksi modular yang konsisten di semua tema.</p>",
    },
  },
  {
    id: "kontak-halaman",
    type: "contact_location",
    enabled: true,
    config: {
      heading: "Hubungi Kantor Pusat",
      address: "Jl. Jenderal Sudirman No. 45, Jakarta Selatan",
      weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
      mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
    },
  },
];

export const REORDERED_TOGGLED_SECTIONS = [
  UNIFIED_HOME_SECTIONS[0], // hero-utama (enabled)
  UNIFIED_HOME_SECTIONS[6], // faq-umum (enabled, moved to #2)
  { ...UNIFIED_HOME_SECTIONS[5], enabled: false }, // testimoni-klien (disabled)
  UNIFIED_HOME_SECTIONS[2], // penawaran (enabled, moved to #3)
  { ...UNIFIED_HOME_SECTIONS[7], enabled: false }, // artikel-terbaru (disabled)
  UNIFIED_HOME_SECTIONS[9], // kontak (enabled, moved to #4)
];

export function buildShell(themeId: string, opts: { isPreview?: boolean; businessCategory?: string } = {}) {
  const themeStyle = buildSafeThemeStyleBlock(null, themeId);
  return {
    isPreview: opts.isPreview ?? false,
    layoutMode: "standard" as const,
    themeId,
    baseThemeId: themeStyle.baseThemeId,
    themeStyle,
    site: {
      title: "PT Nusantara Prima",
      tagline: "Solusi Usaha Terpadu",
      locale: "id-ID",
      timezone: "Asia/Jakarta",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public" as const,
      analyticsConfig: null,
    },
    business: {
      name: "PT Nusantara Prima",
      category: opts.businessCategory ?? "LocalBusiness",
      description: "Mitra layanan usaha dan katalog profesional sejak 2016.",
      address: "Jl. Jenderal Sudirman No. 45",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12190",
      mapsUrl: "https://maps.google.com/?q=-6.2088,106.8456",
      weekdayHours: "Senin–Jumat 08.30–17.00 WIB",
      holidayHours: "Sabtu–Minggu Tutup",
      phone: "6281234567890",
      whatsappE164: "6281234567890",
      email: "halo@nusantara-prima.id",
      socialLinks: [{ platform: "instagram" as const, url: "https://instagram.com/nusantaraprima" }],
    },
    menus: {
      header: [
        { label: "Beranda", href: "/theme-compro/", openInNewTab: false, children: [] },
        { label: "Penawaran", href: "#penawaran", openInNewTab: false, children: [] },
        { label: "Tentang", href: "/tentang-kami/", openInNewTab: false, children: [] },
        { label: "FAQ", href: "#faq-umum", openInNewTab: false, children: [] },
        { label: "Kontak", href: "#kontak", openInNewTab: false, children: [] },
      ],
      footer: [
        { label: "Tentang Kami", href: "/tentang-kami/", openInNewTab: false, children: [] },
        { label: "Penawaran", href: "#penawaran", openInNewTab: false, children: [] },
      ],
      mobile: [],
    },
    page: null,
    revisions: {
      siteSettingsVersion: 1,
      businessProfileVersion: 1,
      themeConfigVersion: 1,
      pageVersion: 1,
    },
  };
}
`,
    "utf8",
  );

  // 1. Create a homepage fixture for EVERY ONE of the 6 platform themes using the EXACT SAME sections!
  for (const theme of PLATFORM_THEMES) {
    fs.writeFileSync(
      path.join(pagesDir, `theme-${theme.id}.astro`),
      `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionRenderer from ${JSON.stringify(rendererImport)};
import { buildShell, UNIFIED_HOME_SECTIONS } from "../fixture-data.ts";

const shell = buildShell(${JSON.stringify(theme.id)});
---
<Layout
  shell={shell}
  currentPath=${JSON.stringify(`/theme-${theme.id}/`)}
  showConsent={false}
  headerCtaLabel="Konsultasi Gratis"
  headerCtaHref="#kontak"
>
  <SectionRenderer
    sections={UNIFIED_HOME_SECTIONS}
    themeId=${JSON.stringify(theme.id)}
    routePath="/"
    isHomepage={true}
    mode="published"
    businessCategory={shell.business.category}
    heroVariant={shell.themeStyle.variants.heroVariant}
    fallbackBusiness={shell.business}
  />
</Layout>
`,
    );
  }

  // 2. Static page `/{pageSlug}` (`/tentang-kami/`)
  fs.writeFileSync(
    path.join(pagesDir, "tentang-kami.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionRenderer from ${JSON.stringify(rendererImport)};
import { buildShell, STATIC_PAGE_SECTIONS } from "../fixture-data.ts";

const shell = buildShell("compro");
---
<Layout shell={shell} pageTitle="Tentang Kami" currentPath="/tentang-kami/" showConsent={false}>
  <SectionRenderer
    sections={STATIC_PAGE_SECTIONS}
    themeId="compro"
    pageSlug="tentang-kami"
    isHomepage={false}
    mode="published"
    businessCategory={shell.business.category}
    fallbackBusiness={shell.business}
  />
</Layout>
`,
  );

  // 3. Preview vs Published parity routes (reordered + toggled off sections)
  for (const mode of ["preview", "published"]) {
    fs.writeFileSync(
      path.join(pagesDir, `parity-${mode}.astro`),
      `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionRenderer from ${JSON.stringify(rendererImport)};
import { buildShell, REORDERED_TOGGLED_SECTIONS } from "../fixture-data.ts";

const shell = buildShell("sales", { isPreview: ${mode === "preview" ? "true" : "false"} });
---
<Layout shell={shell} currentPath=${JSON.stringify(`/parity-${mode}/`)} showConsent={false}>
  <SectionRenderer
    sections={REORDERED_TOGGLED_SECTIONS}
    themeId="sales"
    routePath="/"
    isHomepage={true}
    mode=${JSON.stringify(mode)}
    businessCategory={shell.business.category}
    fallbackBusiness={shell.business}
  />
</Layout>
`,
    );
  }

  // 4. Health-category (`klinik`) Permenkes compliance route — testimonials MUST default OFF!
  fs.writeFileSync(
    path.join(pagesDir, "klinik-health.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionRenderer from ${JSON.stringify(rendererImport)};
import { buildShell, UNIFIED_HOME_SECTIONS } from "../fixture-data.ts";

const shell = buildShell("sales", { businessCategory: "klinik" });
---
<Layout shell={shell} pageTitle="Klinik Sehat" currentPath="/klinik-health/" showConsent={false}>
  <SectionRenderer
    sections={UNIFIED_HOME_SECTIONS}
    themeId="sales"
    pageSlug="klinik-sehat"
    isHomepage={false}
    mode="published"
    businessCategory="klinik"
    fallbackBusiness={shell.business}
  />
</Layout>
`,
  );

  // 5. Invalid config routes (unknown section type & duplicate singleton hero) -> safe fallback
  fs.writeFileSync(
    path.join(pagesDir, "invalid-unknown.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionRenderer from ${JSON.stringify(rendererImport)};
import { buildShell } from "../fixture-data.ts";

const shell = buildShell("compro");
const badSections = [{ id: "bad", type: "script_injector", config: {} }];
---
<Layout shell={shell} showConsent={false}>
  <SectionRenderer sections={badSections} themeId="compro" mode="published" />
</Layout>
`,
  );

  fs.writeFileSync(
    path.join(pagesDir, "invalid-duplicate-hero.astro"),
    `---
import Layout from ${JSON.stringify(layoutImport)};
import SectionRenderer from ${JSON.stringify(rendererImport)};
import { buildShell } from "../fixture-data.ts";

const shell = buildShell("compro");
const dupHeroes = [
  { id: "hero-a", type: "hero", config: { heading: "Hero A" } },
  { id: "hero-b", type: "hero", config: { heading: "Hero B" } },
];
---
<Layout shell={shell} showConsent={false}>
  <SectionRenderer sections={dupHeroes} themeId="compro" mode="published" />
</Layout>
`,
  );

  const { build } = await import(astroEntryUrl);
  await build({
    root: webDir,
    configFile: false,
    output: "static",
    srcDir,
    publicDir,
    outDir,
    cacheDir,
    devToolbar: { enabled: false },
    logLevel: "error",
  });

  return {
    tmpRoot,
    outDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".webp") return "image/webp";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function startStaticServer(outDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!relPath || relPath.endsWith("/")) {
      relPath = path.join(relPath, "index.html");
    }
    let fullPath = path.resolve(outDir, relPath);
    if (!fullPath.startsWith(path.resolve(outDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      const asIndex = path.join(fullPath, "index.html");
      if (fs.existsSync(asIndex)) {
        fullPath = asIndex;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }
    res.writeHead(200, { "Content-Type": getContentType(fullPath) });
    res.end(fs.readFileSync(fullPath));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const fixtures = await buildRealSectionFixtures();
  const server = await startStaticServer(fixtures.outDir);
  const executablePath = findChromeExecutable();

  let browser;
  try {
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // -----------------------------------------------------------------------
    // 0. Static SSR HTML hygiene checks (zero rich-text XSS, zero raw YouTube iframe)
    // -----------------------------------------------------------------------
    const comproHtml = fs.readFileSync(
      path.join(fixtures.outDir, "theme-compro/index.html"),
      "utf8",
    );
    assert(
      !comproHtml.includes("__t013RichTextXss"),
      "Rich text <script> payload MUST be stripped during SSR",
    );
    assert(
      !comproHtml.includes("<iframe"),
      "Gallery YouTube placeholder MUST NOT emit raw <iframe> on initial load",
    );

    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--password-store=basic"],
    });

    // -----------------------------------------------------------------------
    // 1. No-JS Verification @ 360px & 1440px (FAQ <details>, links, zero overflow)
    // -----------------------------------------------------------------------
    for (const vp of [
      { width: 360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      const noJsCtx = await browser.newContext({
        viewport: vp,
        javaScriptEnabled: false,
      });
      const noJsPage = await noJsCtx.newPage();
      const thirdPartyRequests = [];
      noJsPage.on("request", (req) => {
        const u = req.url();
        if (!u.startsWith(server.baseUrl)) thirdPartyRequests.push(u);
      });

      await noJsPage.goto(`${server.baseUrl}/theme-compro/`, { waitUntil: "load" });

      const noJsMetrics = await noJsPage.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        sectionIds: Array.from(document.querySelectorAll("[data-section-id]")).map((el) =>
          el.getAttribute("data-section-id"),
        ),
        waHref: document.querySelector('[data-testid="section-hero-utama-primary-cta"]')?.getAttribute("href"),
      }));

      assert(
        !noJsMetrics.overflow,
        `No-JS @ ${vp.width}px horizontal overflow (${noJsMetrics.scrollWidth} > ${noJsMetrics.innerWidth})`,
      );
      assert(noJsMetrics.sectionIds.length === 10, `No-JS expected 10 sections, got ${noJsMetrics.sectionIds.length}`);
      assert(
        noJsMetrics.waHref === "https://wa.me/6281234567890",
        `No-JS hero WA CTA href mismatch: ${noJsMetrics.waHref}`,
      );
      assert(
        thirdPartyRequests.length === 0,
        `Zero third-party network requests allowed on load (found: ${thirdPartyRequests.join(", ")})`,
      );

      // Native <details>/<summary> FAQ works cleanly with JS disabled!
      const faqDetails = noJsPage.locator('[data-testid="section-faq-umum-faq-item-0"]');
      const faqTrigger = noJsPage.locator('[data-testid="section-faq-umum-faq-trigger-0"]');
      const faqAnswer = noJsPage.locator('[data-testid="section-faq-umum-faq-answer-0"]');

      assert(await faqAnswer.isHidden(), `No-JS @ ${vp.width}px: FAQ answer 0 starts closed`);
      await faqTrigger.click();
      assert(
        await faqDetails.evaluate((el) => el.hasAttribute("open")),
        `No-JS @ ${vp.width}px: FAQ <details> must open without JS`,
      );
      assert(await faqAnswer.isVisible(), `No-JS @ ${vp.width}px: FAQ answer 0 must be visible when open`);
      await faqTrigger.click();
      assert(
        !(await faqDetails.evaluate((el) => el.hasAttribute("open"))),
        `No-JS @ ${vp.width}px: FAQ <details> must close without JS`,
      );

      await noJsCtx.close();
    }

    // -----------------------------------------------------------------------
    // 2. Lossless Theme Switching Across ALL 6 Platform Themes @ 1440px & 360px
    // -----------------------------------------------------------------------
    const consoleErrors = [];
    const pageErrors = [];
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    let baselineFingerprint = null;
    for (const theme of PLATFORM_THEMES) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${server.baseUrl}/theme-${theme.id}/`, { waitUntil: "networkidle" });

      const metrics = await page.evaluate(() => {
        const rootCs = getComputedStyle(document.documentElement);
        const sections = Array.from(document.querySelectorAll("[data-section-id]")).map((el) => ({
          id: el.getAttribute("data-section-id"),
          type: el.getAttribute("data-section-type"),
          heading: el.querySelector("h1, h2")?.textContent?.trim() ?? "",
        }));
        return {
          themeAttr: document.documentElement.getAttribute("data-ps-theme"),
          primary: rootCs.getPropertyValue("--ps-brand-primary").trim(),
          radius: rootCs.getPropertyValue("--ps-radius").trim(),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          richTextXss: Boolean(window.__t013RichTextXss),
          sections,
        };
      });

      assert(metrics.themeAttr === theme.id, `Expected data-ps-theme=${theme.id}, got ${metrics.themeAttr}`);
      assert(
        metrics.primary === theme.primary,
        `Theme ${theme.id} expected --ps-brand-primary ${theme.primary}, got ${metrics.primary}`,
      );
      assert(
        metrics.radius === theme.radius,
        `Theme ${theme.id} expected --ps-radius ${theme.radius}, got ${metrics.radius}`,
      );
      assert(
        !metrics.overflow,
        `Theme ${theme.id} @ 1440px horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
      );
      assert(!metrics.richTextXss, `Theme ${theme.id} must not execute stripped rich-text script`);
      assert(metrics.sections.length === 10, `Theme ${theme.id} expected 10 sections, got ${metrics.sections.length}`);

      const fingerprint = JSON.stringify(metrics.sections);
      if (baselineFingerprint === null) {
        baselineFingerprint = fingerprint;
      } else {
        assert(
          fingerprint === baselineFingerprint,
          `Lossless theme switch FAILED for "${theme.id}": section structure/content changed!`,
        );
      }

      if (screenshotDir && (theme.id === "compro" || theme.id === "resto" || theme.id === "dealer")) {
        // Force eager loading of below-the-fold lazy images without shifting viewport scroll
        await page.evaluate(async () => {
          for (const img of Array.from(document.querySelectorAll("img"))) {
            img.loading = "eager";
          }
          window.scrollTo({ top: 0, behavior: "instant" });
          await Promise.all(
            Array.from(document.querySelectorAll("img")).map((img) =>
              img.complete
                ? Promise.resolve()
                : new Promise((resolve) => {
                    img.addEventListener("load", resolve, { once: true });
                    img.addEventListener("error", resolve, { once: true });
                  }),
            ),
          );
        });
        const brokenImages = await page.evaluate(() =>
          Array.from(document.querySelectorAll("img"))
            .filter((img) => !img.complete || img.naturalWidth === 0)
            .map((img) => img.getAttribute("src")),
        );
        assert(
          brokenImages.length === 0,
          `Theme ${theme.id} has broken images: ${brokenImages.join(", ")}`,
        );
        await page.screenshot({
          path: path.join(screenshotDir, `${theme.id}-1440.png`),
          fullPage: true,
        });
      }

      // Check 360px mobile overflow + touch targets on compro, resto, dealer
      if (theme.id === "compro" || theme.id === "resto" || theme.id === "dealer") {
        await page.setViewportSize({ width: 360, height: 800 });
        const mobileMetrics = await page.evaluate(() => {
          const overflow = document.documentElement.scrollWidth > window.innerWidth;
          const controls = Array.from(document.querySelectorAll(".ps-btn, .ps-faq-summary")).map((el) => {
            const r = el.getBoundingClientRect();
            return { text: el.textContent?.trim() ?? "", h: r.height, w: r.width };
          });
          return {
            overflow,
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            controls,
          };
        });
        assert(
          !mobileMetrics.overflow,
          `Theme ${theme.id} @ 360px horizontal overflow (${mobileMetrics.scrollWidth} > ${mobileMetrics.innerWidth})`,
        );
        for (const c of mobileMetrics.controls) {
          assert(c.h >= 44, `Theme ${theme.id} @ 360px control "${c.text}" height ${c.h}px < 44px`);
        }

        if (screenshotDir && theme.id === "compro") {
          await page.screenshot({
            path: path.join(screenshotDir, "compro-360.png"),
            fullPage: true,
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // 3. Keyboard Accessibility on FAQ <summary> & CTAs
    // -----------------------------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.baseUrl}/theme-compro/`, { waitUntil: "networkidle" });
    const faqTrigger = page.locator('[data-testid="section-faq-umum-faq-trigger-0"]');
    await faqTrigger.focus();
    const faqFocusStyle = await faqTrigger.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth) };
    });
    assert(
      faqFocusStyle.outlineStyle !== "none" && faqFocusStyle.outlineWidth >= 2,
      `FAQ trigger focus ring must be >= 2px, got ${JSON.stringify(faqFocusStyle)}`,
    );
    await page.keyboard.press("Enter");
    assert(
      await page
        .locator('[data-testid="section-faq-umum-faq-item-0"]')
        .evaluate((el) => el.hasAttribute("open")),
      "Keyboard Enter must open FAQ <details>",
    );

    // -----------------------------------------------------------------------
    // 4. Static Page `/{pageSlug}` Verification (`/tentang-kami/`)
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/tentang-kami/`, { waitUntil: "networkidle" });
    const staticPageMetrics = await page.evaluate(() => ({
      routeKind: document.querySelector('[data-testid="page-sections-root"]')?.getAttribute("data-route-kind"),
      routePath: document.querySelector('[data-testid="page-sections-root"]')?.getAttribute("data-route-path"),
      ids: Array.from(document.querySelectorAll("[data-section-id]")).map((el) =>
        el.getAttribute("data-section-id"),
      ),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    assert(staticPageMetrics.routeKind === "page", `Expected routeKind=page, got ${staticPageMetrics.routeKind}`);
    assert(
      staticPageMetrics.routePath === "/tentang-kami",
      `Expected routePath=/tentang-kami, got ${staticPageMetrics.routePath}`,
    );
    assert(
      JSON.stringify(staticPageMetrics.ids) === JSON.stringify(["hero-tentang", "cerita-kami", "kontak-halaman"]),
      `Static page section order mismatch: ${JSON.stringify(staticPageMetrics.ids)}`,
    );
    assert(!staticPageMetrics.overflow, "Static page must have zero overflow");

    // -----------------------------------------------------------------------
    // 5. Preview vs Published Order & Toggle Parity
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/parity-preview/`, { waitUntil: "networkidle" });
    const previewState = await page.evaluate(() => ({
      ids: Array.from(document.querySelectorAll("[data-section-id]")).map((el) =>
        el.getAttribute("data-section-id"),
      ),
      primaryCtaDisabled: document
        .querySelector('[data-testid="section-hero-utama-primary-cta"]')
        ?.getAttribute("aria-disabled"),
      primaryCtaHref: document
        .querySelector('[data-testid="section-hero-utama-primary-cta"]')
        ?.getAttribute("href"),
    }));

    await page.goto(`${server.baseUrl}/parity-published/`, { waitUntil: "networkidle" });
    const publishedState = await page.evaluate(() => ({
      ids: Array.from(document.querySelectorAll("[data-section-id]")).map((el) =>
        el.getAttribute("data-section-id"),
      ),
      primaryCtaHref: document
        .querySelector('[data-testid="section-hero-utama-primary-cta"]')
        ?.getAttribute("href"),
    }));

    const expectedOrder = ["hero-utama", "faq-umum", "penawaran", "kontak"];
    assert(
      JSON.stringify(previewState.ids) === JSON.stringify(expectedOrder),
      `Preview section order/toggle mismatch: ${JSON.stringify(previewState.ids)}`,
    );
    assert(
      JSON.stringify(publishedState.ids) === JSON.stringify(expectedOrder),
      `Published section order/toggle mismatch: ${JSON.stringify(publishedState.ids)}`,
    );
    assert(
      previewState.primaryCtaDisabled === "true" && previewState.primaryCtaHref === null,
      "Preview mode CTAs must be inert (no outbound href)",
    );
    assert(
      publishedState.primaryCtaHref === "https://wa.me/6281234567890",
      "Published mode CTAs must carry live validated href",
    );

    // -----------------------------------------------------------------------
    // 6. Permenkes Health-Category (`klinik`) Default-OFF Testimonials Check
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/klinik-health/`, { waitUntil: "networkidle" });
    const healthMetrics = await page.evaluate(() => ({
      warningsCount: document
        .querySelector('[data-testid="page-sections-root"]')
        ?.getAttribute("data-permenkes-warnings"),
      hasTestimonials: Boolean(document.querySelector('[data-section-type="testimonials"]')),
      renderedCount: document.querySelectorAll("[data-section-id]").length,
    }));
    assert(
      !healthMetrics.hasTestimonials,
      "Health category (klinik) MUST default testimonials OFF (not rendered in DOM)",
    );
    assert(
      healthMetrics.warningsCount === "1",
      `Health category expected data-permenkes-warnings=1, got ${healthMetrics.warningsCount}`,
    );
    assert(
      healthMetrics.renderedCount === 9,
      `Health category expected 9 rendered sections (10 minus testimonials), got ${healthMetrics.renderedCount}`,
    );

    // -----------------------------------------------------------------------
    // 7. Invalid Section Configs Fail Safely Without Crashing
    // -----------------------------------------------------------------------
    await page.goto(`${server.baseUrl}/invalid-unknown/`, { waitUntil: "networkidle" });
    const unknownErrCode = await page
      .locator('[data-testid="section-renderer-error"]')
      .getAttribute("data-error-code");
    assert(
      unknownErrCode === "UNKNOWN_SECTION_TYPE",
      `Expected UNKNOWN_SECTION_TYPE fallback, got ${unknownErrCode}`,
    );

    await page.goto(`${server.baseUrl}/invalid-duplicate-hero/`, { waitUntil: "networkidle" });
    const dupErrCode = await page
      .locator('[data-testid="section-renderer-error"]')
      .getAttribute("data-error-code");
    assert(
      dupErrCode === "DUPLICATE_SINGLETON_SECTION",
      `Expected DUPLICATE_SINGLETON_SECTION fallback, got ${dupErrCode}`,
    );

    assert(consoleErrors.length === 0, `Console errors detected: ${consoleErrors.join("; ")}`);
    assert(pageErrors.length === 0, `Page errors detected: ${pageErrors.join("; ")}`);

    console.log(
      "TASK-013 E2E PASS: Unified closed section registry rendered across all 6 platform themes (compro/sales/travel/catalog/resto/dealer) with 100% lossless theme switch, static page /{pageSlug}, preview/published order+toggle parity, Permenkes health-category testimonials default-off, invalid unknown/duplicate singleton safe failure, No-JS FAQ <details> + links at 360px/1440px, >=44px mobile targets, >=2px keyboard focus ring, 0 overflow, 0 third-party requests, 0 console/page errors.",
    );
  } catch (err) {
    console.error("TASK-013 E2E FAILED:", err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await server.close();
    fixtures.cleanup();
  }
}

await main();
